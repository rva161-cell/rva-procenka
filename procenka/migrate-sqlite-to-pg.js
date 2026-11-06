// Разовый перенос данных SQLite → PostgreSQL. Запускать ПРИ ОСТАНОВЛЕННЫХ службах:
//   cd /opt/rva/procenka && node migrate-sqlite-to-pg.js
// Читает data.db (SQLite), заливает в базу из PG*-переменных procenka/.env, сверяет счётчики.
const fs = require("fs"), path = require("path");
const root = __dirname;
for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { DatabaseSync } = require("node:sqlite");
const { Client, types } = require("pg");
const { ensureSchema } = require("./db");
types.setTypeParser(20, Number);   // COUNT(*) (int8) приходит строкой — делаем числом

const TABLES = ["users", "sessions", "registrations", "referrals", "questions", "settings",
  "access_log", "o_tasks", "o_audit", "o_contacts", "o_files", "o_notes"];
const SERIALS = ["referrals", "questions", "access_log", "o_tasks", "o_audit", "o_contacts", "o_files", "o_notes"];

(async () => {
  const src = new DatabaseSync(path.join(root, "data.db"));
  src.exec("PRAGMA busy_timeout = 5000;");
  const dst = new Client({
    host: process.env.PGHOST || "127.0.0.1", port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "rva", user: process.env.PGUSER || "rva",
    password: process.env.PGPASSWORD || "",
  });
  await dst.connect();
  await ensureSchema(dst);
  await dst.query(`TRUNCATE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`);
  let ok = true;
  for (const t of TABLES) {
    const rows = src.prepare(`SELECT * FROM ${t}`).all();
    for (const row of rows) {
      const cols = Object.keys(row);
      const vals = cols.map(c => (row[c] === undefined ? null : row[c]));
      await dst.query(`INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(", ")})
        VALUES (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, vals);
    }
    if (SERIALS.includes(t))
      await dst.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
    const pgN = (await dst.query(`SELECT COUNT(*) n FROM ${t}`)).rows[0].n;
    const line = `  ${t}: SQLite ${rows.length} → PG ${pgN}`;
    if (rows.length !== pgN) { ok = false; console.log(line + "   ← РАСХОЖДЕНИЕ"); }
    else console.log(line);
  }
  await dst.end();
  console.log(ok ? "Перенос завершён, расхождений нет." : "ПЕРЕНОС С РАСХОЖДЕНИЯМИ — службы не запускать, разобраться!");
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error("Перенос не удался:", e.message); process.exit(1); });
