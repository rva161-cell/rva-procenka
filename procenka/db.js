// База проценки — PostgreSQL 16 (решение 25.10: PG сразу на VPS).
// Хранит пользователей, сессии входа, заявки на регистрацию, приглашения, вопросы из ботов,
// настройки и данные органайзера (задачи, журнал, контакты, файлы, записная книжка).
// В файлах остаются: suppliers.json (настройки с ключами), close_people.json (правится руками),
// news.json (лента).
//
// API синхронный (как был с node:sqlite), чтобы не переписывать server.js: запросы выполняет
// фоновый поток db-worker.js (пул pg), главный поток ждёт результат через Atomics.wait.
// Подключение: PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD из procenka/.env (читает server.js).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Worker } = require("worker_threads");

const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL = 30 * DAY;   // вход живёт 30 дней с последнего визита
const REG_TTL = DAY;            // ссылка подтверждения email — 24 часа
const BACKUPS_KEEP = 14;        // ежедневных копий базы

// Схема PostgreSQL — 1:1 к прежней SQLite (включая дозаписанные колонки).
// UNIQUE COLLATE NOCASE → уникальный индекс по lower(login).
const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  approved INTEGER NOT NULL DEFAULT 0,
  level INTEGER,
  name TEXT, surname TEXT, patronymic TEXT, email TEXT,
  phone TEXT, max_id TEXT, telegram_id TEXT,
  created BIGINT,
  extra TEXT                    -- прочие поля пользователя (JSON), чтобы ничего не терять
);
CREATE UNIQUE INDEX IF NOT EXISTS users_login_ci ON users(lower(login));
CREATE INDEX IF NOT EXISTS users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS users_max ON users(max_id);
CREATE INDEX IF NOT EXISTS users_tg ON users(telegram_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY,    -- в базе только хеш: утечка файла не даёт войти чужими сессиями
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created BIGINT NOT NULL,
  expires BIGINT NOT NULL,
  ip TEXT                       -- адрес, с которого выполнен вход; с другого адреса сессия гасится
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS registrations (
  token TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  data TEXT NOT NULL,           -- JSON: name, surname, patronymic, pass (хеш), phone
  created BIGINT NOT NULL,
  sent BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS registrations_login_ci ON registrations(lower(login));

CREATE TABLE IF NOT EXISTS referrals (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT '',
  tid TEXT NOT NULL,
  inviter TEXT NOT NULL DEFAULT '',
  inviter_id TEXT NOT NULL,
  CONSTRAINT referrals_transport_tid UNIQUE (transport, tid)
);
CREATE INDEX IF NOT EXISTS referrals_inviter ON referrals(inviter_id);

CREATE TABLE IF NOT EXISTS questions (
  id BIGSERIAL PRIMARY KEY,
  date TEXT NOT NULL,
  transport TEXT NOT NULL,
  tid TEXT NOT NULL,
  from_login TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);

-- Настройки программы «ключ → значение» (например, наценка для гостей проценки)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- История платного доступа к проценке: кто, когда и на сколько продлил (для учёта оплат)
CREATE TABLE IF NOT EXISTS access_log (
  id BIGSERIAL PRIMARY KEY,
  ts BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  login TEXT NOT NULL DEFAULT '',
  admin TEXT NOT NULL DEFAULT '',
  days_before TEXT NOT NULL DEFAULT '',   -- было: число дней или «бессрочно»
  days_after TEXT NOT NULL DEFAULT '',    -- стало
  until BIGINT,                           -- новая дата окончания (мс), NULL — бессрочно / закрыт
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS access_log_user ON access_log(user_id);

-- Органайзер (5-й уровень): задачи + журнал действий. Префикс o_ — чтобы
-- имена не пересекались с будущими таблицами сайта.
CREATE TABLE IF NOT EXISTS o_tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',  -- manual | max | telegram | mail:<ящик>
  contact TEXT NOT NULL DEFAULT '',       -- автор: логин, адрес письма или «id …» из бота
  contact_id BIGINT,
  due_date TEXT NOT NULL,                 -- YYYY-MM-DD, день в календаре
  due_time TEXT,                          -- HH:MM или NULL («весь день»)
  done INTEGER NOT NULL DEFAULT 0,
  done_by TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  carry INTEGER NOT NULL DEFAULT 0,       -- сколько раз авто-перенесена на сегодня
  rec TEXT NOT NULL DEFAULT '',           -- повтор: daily|weekly|monthly|yearly
  mins INTEGER NOT NULL DEFAULT 25,       -- таймфрейм задачи, минут
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS o_tasks_due ON o_tasks(due_date);

CREATE TABLE IF NOT EXISTS o_audit (
  id BIGSERIAL PRIMARY KEY,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,                    -- кто: логин, «бот max», «система»
  action TEXT NOT NULL,
  task_id BIGINT,
  details TEXT NOT NULL DEFAULT ''
);

-- контакты (О-2): авто из писем + ручные; login/max_id/telegram_id — при склейке с пользователем
CREATE TABLE IF NOT EXISTS o_contacts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  login TEXT NOT NULL DEFAULT '',
  max_id TEXT NOT NULL DEFAULT '',
  telegram_id TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- файлы (О-3/О-4): скрепки записных книжек, вложения писем, сканы; лежат в Organizer/files
CREATE TABLE IF NOT EXISTS o_files (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL DEFAULT '',         -- чья книжка (логин)
  note_id BIGINT,                         -- запись книжки, если файл прикреплён к ней
  task_id BIGINT,                         -- задача, если файл пришёл письмом/сканом к задаче
  name TEXT NOT NULL,                     -- отображаемое имя
  stored TEXT NOT NULL,                   -- относительный путь внутри Organizer/files
  kind TEXT NOT NULL DEFAULT 'file',      -- image | pdf | txt | doc
  size BIGINT NOT NULL DEFAULT 0,
  yadisk TEXT NOT NULL DEFAULT '',        -- публичная ссылка Яндекс.Диска
  created_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- записная книжка (О-3): персональная у каждого
CREATE TABLE IF NOT EXISTS o_notes (
  id BIGSERIAL PRIMARY KEY,
  owner TEXT NOT NULL,                    -- логин владельца
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- расход фото по квоте у незарегистрированных (1 уровень, считаем по id мессенджера)
CREATE TABLE IF NOT EXISTS guest_photos (
  tid TEXT PRIMARY KEY,                   -- transport:tid
  day TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
`;

// дозаписи в существующие таблицы (CREATE IF NOT EXISTS старую таблицу не меняет)
const ENSURE_COLS = [
  ["o_tasks", "contact_id", "INTEGER"],
  ["o_tasks", "rec", "TEXT NOT NULL DEFAULT ''"],
  ["o_tasks", "mins", "INTEGER NOT NULL DEFAULT 25"],
  ["sessions", "ip", "TEXT"],
];

// создание/досоздание схемы на готовом клиенте pg (использует migrate-sqlite-to-pg.js)
async function ensureSchema(client) {
  await client.query(SCHEMA_PG);
  for (const [table, col, def] of ENSURE_COLS) {
    const have = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, col]);
    if (!have.rowCount) await client.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

const USER_COLS = ["id", "login", "pass", "role", "approved", "level", "name", "surname", "patronymic",
  "email", "phone", "max_id", "telegram_id", "created"];

function userToRow(u) {
  const row = {}, extra = {};
  for (const [k, v] of Object.entries(u)) (USER_COLS.includes(k) ? row : extra)[k] = v;
  for (const k of USER_COLS) if (row[k] === undefined) row[k] = null;
  row.approved = row.approved ? 1 : 0;
  row.role = row.role || "user";
  row.level = typeof row.level === "number" ? row.level : null;
  for (const k of ["max_id", "telegram_id", "phone"]) if (row[k] !== null) row[k] = String(row[k]);
  row.extra = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return row;
}
function rowToUser(r) {
  const u = r.extra ? JSON.parse(r.extra) : {};
  for (const k of USER_COLS) if (r[k] !== null && r[k] !== undefined) u[k] = r[k];
  u.approved = !!r.approved;
  return u;
}
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");

function openDb(root) {
  const cfg = {
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "rva",
    user: process.env.PGUSER || "rva",
    password: process.env.PGPASSWORD || "",
  };

  // ---------- синхронный мост к фоновому потоку ----------
  // Ответ кладётся потоком в общий буфер и накрывается флагом: «флаг = 1» ⇒ данные готовы.
  // Нельзя передавать ответ событием message — его обработчик не выполнится, пока главный
  // поток заблокирован синхронным кодом (проверено: получался вечный цикл).
  const CAP = 8 * 1024 * 1024;
  const sab = new SharedArrayBuffer(8 + CAP);
  const signal = new Int32Array(sab, 0, 2);
  const worker = new Worker(path.join(__dirname, "db-worker.js"), { workerData: { ...cfg, sab } });
  worker.unref();
  let seq = 0;
  worker.on("error", e => console.error("[база] поток:", e.message));
  function call(payload) {
    const id = ++seq;
    Atomics.store(signal, 0, 0);
    worker.postMessage({ id, ...payload });
    if (Atomics.wait(signal, 0, 0, 30000) === "timed-out" && Atomics.load(signal, 0) !== 1)
      throw new Error("База не отвечает (таймаут запроса)");
    const len = Atomics.load(signal, 1);
    const m = JSON.parse(Buffer.from(sab, 8, len).toString("utf8"));
    if (m.error) throw new Error(m.error);
    return m;
  }
  const q = (sql, params = []) => call({ type: "q", sql, params }).rows;
  const one = (sql, params = []) => q(sql, params)[0];
  const exec = sql => call({ type: "exec", sql });
  const changes = (sql, params = []) => call({ type: "q", sql, params }).rowCount;

  let txDepth = 0;
  const tx = fn => {
    if (txDepth > 0) return fn();
    call({ type: "begin" }); txDepth++;
    try { const r = fn(); call({ type: "commit" }); return r; }
    catch (e) { try { call({ type: "rollback" }); } catch (_) {} throw e; }
    finally { txDepth--; }
  };

  exec(SCHEMA_PG);
  exec("ALTER TABLE o_tasks ALTER COLUMN due_date DROP NOT NULL");   // задачи «без срока» живут в «Задачах»
  console.log("[база] схема готова");
  for (const [table, col, def] of ENSURE_COLS) {
    if (!q("SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2", [table, col]).length)
      exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }

  // ---------- пользователи ----------
  const users = {
    all: () => q("SELECT * FROM users ORDER BY created").map(rowToUser),
    save: u => {
      const row = userToRow(u), cols = [...USER_COLS, "extra"];
      q(`INSERT INTO users (${cols.join(", ")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})
         ON CONFLICT (id) DO UPDATE SET ${cols.slice(1).map(c => `${c} = EXCLUDED.${c}`).join(", ")}`,
        cols.map(c => row[c]));
    },
    remove: id => { changes("DELETE FROM users WHERE id = $1", [id]); },
  };

  // ---------- сессии ----------
  const sessions = {
    create(userId, ip) {
      const sid = crypto.randomBytes(32).toString("hex");
      const now = Date.now();
      q("INSERT INTO sessions (sid_hash, user_id, created, expires, ip) VALUES ($1, $2, $3, $4, $5)",
        [sha(sid), userId, now, now + SESSION_TTL, ip ? String(ip) : null]);
      return sid;
    },
    // id пользователя по cookie; срок продлевается не чаще раза в сутки.
    // ip задан и у сессии записан другой адрес (например, cookie украли) — сессия гасится
    userId(sid, ip) {
      if (!sid) return null;
      const h = sha(sid), now = Date.now();
      const r = one("SELECT user_id, expires, ip FROM sessions WHERE sid_hash = $1", [h]);
      if (!r) return null;
      if (r.expires < now) { changes("DELETE FROM sessions WHERE sid_hash = $1", [h]); return null; }
      if (ip && r.ip && r.ip !== String(ip)) { changes("DELETE FROM sessions WHERE sid_hash = $1", [h]); return null; }
      if (r.expires - now < SESSION_TTL - DAY) changes("UPDATE sessions SET expires = $1 WHERE sid_hash = $2", [now + SESSION_TTL, h]);
      return r.user_id;
    },
    remove: sid => { if (sid) changes("DELETE FROM sessions WHERE sid_hash = $1", [sha(sid)]); },
    // выйти на всех устройствах, кроме текущего (после смены пароля)
    removeOthers: (userId, keepSid) => {
      changes("DELETE FROM sessions WHERE user_id = $1 AND sid_hash <> $2", [userId, sha(keepSid || "")]);
    },
    purge: () => { changes("DELETE FROM sessions WHERE expires < $1", [Date.now()]); },
    ttlSeconds: SESSION_TTL / 1000,
  };

  // ---------- заявки на регистрацию (до подтверждения email) ----------
  const regFromRow = r => r && { ...JSON.parse(r.data), login: r.login, token: r.token, created: r.created, sent: r.sent };
  const registrations = {
    put(reg) { // одна заявка на email: новая заменяет прежнюю
      const { login, token, created, sent, ...data } = reg;
      tx(() => {
        changes("DELETE FROM registrations WHERE lower(login) = lower($1)", [login]);
        q("INSERT INTO registrations (token, login, data, created, sent) VALUES ($1, $2, $3, $4, $5)",
          [token, login, JSON.stringify(data), created, sent]);
      });
    },
    list: () => q("SELECT * FROM registrations ORDER BY created DESC").map(regFromRow),
    byToken: t => regFromRow(one("SELECT * FROM registrations WHERE token = $1", [String(t)])),
    byLogin: l => regFromRow(one("SELECT * FROM registrations WHERE lower(login) = lower($1)", [String(l)])),
    retoken(oldToken, newToken) {
      const now = Date.now();
      changes("UPDATE registrations SET token = $1, created = $2, sent = $3 WHERE token = $4", [newToken, now, now, oldToken]);
    },
    remove: t => { changes("DELETE FROM registrations WHERE token = $1", [String(t)]); },
    purge: () => { changes("DELETE FROM registrations WHERE created < $1", [Date.now() - REG_TTL]); },
    ttl: REG_TTL,
  };

  // ---------- приглашения в ботов ----------
  const referrals = {
    // false — этот приглашённый уже записан (повторный переход по ссылке)
    add: r => changes(`INSERT INTO referrals (date, transport, tid, inviter, inviter_id)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT (transport, tid) DO NOTHING`,
      [r.date, r.transport, r.tid, r.inviter || "", r.inviter_id]) > 0,
    exists: (transport, tid) => !!one("SELECT 1 FROM referrals WHERE transport = $1 AND tid = $2", [transport, tid]),
    // старые записи без transport считаются для любого мессенджера (как было в referrals.json)
    countBy: (inviterId, transport) => inviterId === undefined || inviterId === null || inviterId === "" ? 0 :
      one("SELECT COUNT(*) n FROM referrals WHERE inviter_id = $1 AND (transport = $2 OR transport = '')",
        [String(inviterId), transport]).n,
    list: (limit = 500) => q("SELECT date, transport, tid, inviter, inviter_id FROM referrals ORDER BY id DESC LIMIT $1", [limit]).reverse(),
  };

  // ---------- вопросы из ботов ----------
  const questions = {
    add: qq => { q("INSERT INTO questions (date, transport, tid, from_login, text) VALUES ($1, $2, $3, $4, $5)",
      [qq.date, qq.transport, qq.tid, qq.from || "", qq.text]); },
    list: (limit = 500) => q(`SELECT date, transport, tid, from_login AS "from", text FROM questions ORDER BY id DESC LIMIT $1`, [limit]).reverse(),
  };

  // ---------- органайзер: задачи и журнал ----------
  const oRow = r => r && ({ ...r, done: !!r.done, deleted: !!r.deleted });
  const oAudit = {
    log: (actor, action, task_id, details = "") => {
      q("INSERT INTO o_audit (ts, actor, action, task_id, details) VALUES ($1, $2, $3, $4, $5)",
        [new Date().toISOString(), actor, action, task_id, String(details)]);
    },
    list: (limit = 300) => q("SELECT ts, actor, action, task_id, details FROM o_audit ORDER BY id DESC LIMIT $1", [limit]),
  };
  const oTasks = {
    add: t => {
      const r = one(`INSERT INTO o_tasks (title, body, source, contact, contact_id, due_date, due_time, rec, mins, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [t.title, t.body || "", t.source || "manual", t.contact || "", t.contact_id || null,
         t.due_date, t.due_time || null, t.rec || "", t.mins || 25, t.created_at]);
      return Number(r.id);
    },
    get: id => oRow(one("SELECT * FROM o_tasks WHERE id = $1", [Number(id)])),
    list(f) { // f: {view, date, date2, q, includeDone}
      const w = [], a = [];
      const P = v => { a.push(v); return "$" + a.length; };
      if (f.view === "inbox") { w.push("deleted = 0", "due_date IS NULL"); }   // «Задачи» — только без срока
      else if (f.view === "today") { w.push("done = 0", "deleted = 0", `due_date <= ${P(f.date)}`); } // «Сегодня»: невыполненные на сегодня и просроченные
      else if (f.view === "day") { w.push("deleted = 0", `due_date = ${P(f.date)}`); if (!f.includeDone) w.push("done = 0"); } // календарь: выполненные остаются (перечёркиваются)
      else if (f.view === "week") { w.push("deleted = 0", `due_date >= ${P(f.date)}`, `due_date <= ${P(f.date2)}`); if (!f.includeDone) w.push("done = 0"); }
      else if (f.view === "archive") { w.push("done = 1", "deleted = 0"); }
      else if (f.view === "trash") { w.push("deleted = 1"); }
      else { w.push("deleted = 0"); if (!f.includeDone) w.push("done = 0"); } // поиск и месяц — по всем живым
      if (f.q) { const like = "%" + f.q + "%"; w.push(`(title ILIKE ${P(like)} OR body ILIKE ${P(like)})`); }
      const order = f.view === "inbox" ? "id DESC" : f.view === "archive" ? "done_at DESC" :
                    f.view === "trash" ? "deleted_at DESC" : "(due_time IS NULL), due_time, id DESC";
      return q(`SELECT * FROM o_tasks WHERE ${w.join(" AND ")} ORDER BY ${order} LIMIT 500`, a).map(oRow);
    },
    counts: () => {
      const today = new Date(), t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return {
        inbox: one("SELECT COUNT(*) n FROM o_tasks WHERE deleted = 0 AND due_date IS NULL").n,
        today: one("SELECT COUNT(*) n FROM o_tasks WHERE done = 0 AND deleted = 0 AND due_date = $1", [t]).n,
        carried: one("SELECT COALESCE(SUM(carry), 0) n FROM o_tasks WHERE done = 0 AND deleted = 0").n,
      };
    },
    setDone: (id, done, by, ts) => changes("UPDATE o_tasks SET done = $1, done_by = $2, done_at = $3 WHERE id = $4",
      [done ? 1 : 0, done ? by : "", done ? ts : null, Number(id)]),
    move: (id, date, time) => changes("UPDATE o_tasks SET due_date = $1, due_time = $2 WHERE id = $3",
      [date, time || null, Number(id)]),
    edit: (id, t) => changes("UPDATE o_tasks SET title = $1, body = $2, due_date = $3, due_time = $4, rec = $5, mins = $6 WHERE id = $7",
      [t.title, t.body || "", t.due_date, t.due_time || null, t.rec || "", t.mins || 25, Number(id)]),
    softDelete: (id, ts) => changes("UPDATE o_tasks SET deleted = 1, deleted_at = $1 WHERE id = $2", [ts, Number(id)]),
    restore: id => changes("UPDATE o_tasks SET deleted = 0, deleted_at = NULL WHERE id = $1", [Number(id)]),
    // невыполненное с прошедшей датой → сегодня; сколько перенесли
    carryOver: today => {
      const n = one("SELECT COUNT(*) n FROM o_tasks WHERE done = 0 AND deleted = 0 AND due_date < $1", [today]).n;
      if (n) changes("UPDATE o_tasks SET due_date = $1, carry = carry + 1 WHERE done = 0 AND deleted = 0 AND due_date < $1", [today]);
      return n;
    },
    // повторяющиеся: выполненный повтор просрочен → создаём следующий экземпляр (п.3 ТЗ)
    spawnRecurring: today => {
      const rows = q("SELECT * FROM o_tasks WHERE rec <> '' AND deleted = 0 AND due_date < $1", [today]);
      let made = 0;
      for (const t of rows) {
        if (!t.done) continue; // невыполненный повтор уедет на сегодня как обычный (carryOver)
        let d = new Date(t.due_date + "T12:00:00");
        do {
          if (t.rec === "daily") d.setDate(d.getDate() + 1);
          else if (t.rec === "weekly") d.setDate(d.getDate() + 7);
          else if (t.rec === "monthly") d.setMonth(d.getMonth() + 1);
          else d.setFullYear(d.getFullYear() + 1);
        } while (d < new Date(today + "T12:00:00"));
        const nd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        q(`INSERT INTO o_tasks (title, body, source, contact, contact_id, due_date, due_time, rec, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [t.title, t.body, t.source, t.contact, t.contact_id, nd, t.due_time, t.rec, new Date().toISOString()]);
        made++;
      }
      return made;
    },
    // архив живёт 14 дней → в корзину; корзина 30 дней → удалить физически (п.5 ТЗ)
    autoClean: (trashEdge, delEdge) => {
      const toTrash = changes(`UPDATE o_tasks SET deleted = 1, deleted_at = $1
        WHERE done = 1 AND deleted = 0 AND done_at IS NOT NULL AND done_at < $1`,
        [new Date(trashEdge).toISOString()]);
      const gone = changes("DELETE FROM o_tasks WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at < $1",
        [new Date(delEdge).toISOString()]);
      return { toTrash, gone };
    },
  };

  // ---------- органайзер: контакты, файлы, записная книжка ----------
  const oContacts = {
    add: c => {
      const r = one(`INSERT INTO o_contacts (name, email, phone, login, max_id, telegram_id, note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [c.name || "", (c.email || "").toLowerCase(), c.phone || "", c.login || "", String(c.max_id || ""), String(c.telegram_id || ""), c.note || "", c.created_at]);
      return Number(r.id);
    },
    get: id => one("SELECT * FROM o_contacts WHERE id = $1", [Number(id)]),
    // контакт по email/телефону — чтобы письма одного адресата не плодили дубли
    byEmailOrPhone: (email, phone) => {
      const e = String(email || "").toLowerCase(), p = String(phone || "").replace(/\D/g, "");
      if (e) { const r = one("SELECT * FROM o_contacts WHERE email = $1 AND email <> ''", [e]); if (r) return r; }
      if (p) { const r = one("SELECT * FROM o_contacts WHERE REPLACE(REPLACE(REPLACE(phone,'+',''),'(',''),')','') = $1 AND phone <> ''", [p]); if (r) return r; }
      return null;
    },
    update: (id, c) => changes(`UPDATE o_contacts SET
      name = COALESCE(NULLIF($1, ''), name), email = CASE WHEN $2 <> '' THEN $3 ELSE email END,
      phone = CASE WHEN $4 <> '' THEN $5 ELSE phone END, login = CASE WHEN $6 <> '' THEN $7 ELSE login END,
      max_id = CASE WHEN $8 <> '' THEN $9 ELSE max_id END, telegram_id = CASE WHEN $10 <> '' THEN $11 ELSE telegram_id END
      WHERE id = $12`,
      [c.name || "", c.email || "", (c.email || "").toLowerCase(), c.phone || "", c.phone || "",
       c.login || "", c.login || "", String(c.max_id || ""), String(c.max_id || ""),
       String(c.telegram_id || ""), String(c.telegram_id || ""), Number(id)]),
    list: (qq = "") => {
      if (qq) { const like = `%${qq}%`;
        return q(`SELECT * FROM o_contacts
          WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR login ILIKE $1 OR note ILIKE $1
          ORDER BY lower(name) LIMIT 500`, [like]); }
      return q("SELECT * FROM o_contacts ORDER BY lower(name) LIMIT 500");
    },
  };
  const oFiles = {
    add: f => {
      const r = one(`INSERT INTO o_files (owner, note_id, task_id, name, stored, kind, size, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [f.owner || "", f.note_id || null, f.task_id || null, f.name, f.stored, f.kind || "file", f.size || 0, f.created_at]);
      return Number(r.id);
    },
    get: id => one("SELECT * FROM o_files WHERE id = $1", [Number(id)]),
    byNote: noteId => q("SELECT * FROM o_files WHERE note_id = $1 AND deleted = 0 ORDER BY id", [Number(noteId)]),
    byTask: taskId => q("SELECT * FROM o_files WHERE task_id = $1 AND deleted = 0 ORDER BY id", [Number(taskId)]),
    recent: (limit = 10) => q("SELECT * FROM o_files WHERE deleted = 0 ORDER BY id DESC LIMIT $1", [limit]),
    setYadisk: (id, url) => changes("UPDATE o_files SET yadisk = $1 WHERE id = $2", [url || "", Number(id)]),
    softDelete: id => changes("UPDATE o_files SET deleted = 1 WHERE id = $1", [Number(id)]),
  };
  const LETTER_RE = /[a-zа-яё]/i;
  const letterOf = title => {
    const ch = String(title || "").trim().charAt(0).toUpperCase();
    return LETTER_RE.test(ch) ? ch : "#";
  };
  const oNotes = {
    add: n => {
      const now = new Date().toISOString();
      const r = one("INSERT INTO o_notes (owner, title, body, created_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING id",
        [n.owner, n.title, n.body || "", now, now]);
      return Number(r.id);
    },
    get: (id, owner) => one("SELECT * FROM o_notes WHERE id = $1 AND owner = $2 AND deleted = 0", [Number(id), owner]),
    // буквы считаем в JS: upper() в PostgreSQL не знает русский алфавит
    listLetters: owner => {
      const rows = q("SELECT title FROM o_notes WHERE owner = $1 AND deleted = 0", [owner]);
      const m = new Map();
      for (const r of rows) { const L = letterOf(r.title); m.set(L, (m.get(L) || 0) + 1); }
      return [...m.entries()].map(([letter, n]) => ({ letter, n }))
        .sort((a, b) => a.letter.localeCompare(b.letter, "ru"));
    },
    listByLetter: (owner, letter) => q("SELECT * FROM o_notes WHERE owner = $1 AND deleted = 0 ORDER BY updated_at DESC", [owner])
      .filter(r => letterOf(r.title) === letter)
      .sort((a, b) => a.title.localeCompare(b.title, "ru")),
    update: (id, n) => changes("UPDATE o_notes SET title = $1, body = $2, updated_at = $3 WHERE id = $4",
      [n.title, n.body || "", new Date().toISOString(), Number(id)]),
    softDelete: id => changes("UPDATE o_notes SET deleted = 1 WHERE id = $1", [Number(id)]),
  };

  // ---------- перенос из прежних JSON-файлов (один раз) ----------
  const count = t => one(`SELECT COUNT(*) n FROM ${t}`).n;
  const migrate = (name, table, importFn) => {
    const f = path.join(root, name);
    if (!fs.existsSync(f) || count(table) > 0) return;
    const list = JSON.parse(fs.readFileSync(f, "utf8") || "[]");
    tx(() => (Array.isArray(list) ? list : []).forEach(importFn));
    fs.renameSync(f, f + ".migrated");
    console.log(`База: перенесено из ${name} — ${Array.isArray(list) ? list.length : 0} записей (файл сохранён как ${name}.migrated)`);
  };
  migrate("users.json", "users", u => users.save(u));
  migrate("registrations.json", "registrations", r => {
    if (Date.now() - (r.created || 0) < REG_TTL) registrations.put({ sent: r.created, ...r });
  });
  migrate("referrals.json", "referrals", r => referrals.add({ ...r, transport: r.transport || "", tid: String(r.tid), inviter_id: String(r.inviter_id) }));
  migrate("questions.json", "questions", qq => questions.add({ ...qq, tid: String(qq.tid || ""), text: String(qq.text || "") }));

  // ---------- резервная копия: раз в сутки, хранится BACKUPS_KEEP последних ----------
  const backupDir = path.join(root, "backups");
  function backup() {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const target = path.join(backupDir, `data-${new Date().toISOString().slice(0, 10)}.sql`);
      if (fs.existsSync(target)) return;
      const { execFileSync } = require("child_process");
      execFileSync("pg_dump", ["-h", cfg.host, "-p", String(cfg.port), "-U", cfg.user, "-d", cfg.database,
        "--no-owner", "--no-privileges"],
        { env: { ...process.env, PGPASSWORD: cfg.password }, stdio: ["ignore", fs.openSync(target, "w"), "ignore"] });
      const old = fs.readdirSync(backupDir).filter(f => /^data-\d{4}-\d{2}-\d{2}\.sql$/.test(f)).sort().slice(0, -BACKUPS_KEEP);
      old.forEach(f => fs.unlinkSync(path.join(backupDir, f)));
      console.log("[база] копия создана:", path.basename(target));
    } catch (e) { console.error("Резервная копия базы не создана:", e.message); }
  }
  // ---------- расход фото у незарегистрированных (1 уровень) ----------
  const guestPhotos = {
    today: (key, day) => { const r = one("SELECT used FROM guest_photos WHERE tid = $1 AND day = $2", [key, day]); return r ? r.used : 0; },
    use: (key, day) => {
      const used = guestPhotos.today(key, day) + 1;
      q(`INSERT INTO guest_photos (tid, day, used) VALUES ($1, $2, $3)
         ON CONFLICT (tid) DO UPDATE SET day = EXCLUDED.day, used = EXCLUDED.used`, [key, day, used]);
      return used;
    },
  };

  // ---------- настройки ----------
  const accessLog = {
    add: r => { q(`INSERT INTO access_log (ts, user_id, login, admin, days_before, days_after, until, note)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [r.ts, r.user_id, r.login || "", r.admin || "", String(r.days_before ?? ""),
      String(r.days_after ?? ""), r.until ?? null, r.note || ""]); },
    list: (limit = 2000) => q("SELECT * FROM access_log ORDER BY id DESC LIMIT $1", [limit]),
  };
  const settings = {
    get: (key, def) => { const r = one("SELECT value FROM settings WHERE key = $1", [key]); return r ? JSON.parse(r.value) : def; },
    set: (key, value) => { q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, JSON.stringify(value)]); },
  };

  backup();
  sessions.purge(); registrations.purge();
  setInterval(() => { backup(); sessions.purge(); registrations.purge(); }, 60 * 60 * 1000).unref();

  return { users, sessions, registrations, referrals, questions, settings, accessLog, oTasks, oAudit, oContacts, oFiles, oNotes, guestPhotos, letterOf, file: `pg:${cfg.database}@${cfg.host}` };
}

module.exports = { openDb, ensureSchema };
