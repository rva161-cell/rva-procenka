// Фоновый поток базы PostgreSQL: держит пул соединений и выполняет запросы главного потока.
// Главный поток (db.js) блокируется через Atomics.wait, поэтому API базы остаётся синхронным —
// server.js не приходится переписывать на async. Транзакция: "begin" выделяет потоку отдельный
// клиент, все запросы до "commit"/"rollback" идут через него.
const { parentPort, workerData } = require("worker_threads");
const pg = require("pg");

// BIGINT (метки времени в мс) и NUMERIC по умолчанию приходят строками — превращаем в числа
// (значения до 2^53, потери точности нет)
pg.types.setTypeParser(20, Number);    // int8
pg.types.setTypeParser(1700, Number);  // numeric

const pool = new pg.Pool({
  host: workerData.host, port: workerData.port,
  database: workerData.database, user: workerData.user, password: workerData.password,
  max: 4, connectionTimeoutMillis: 8000,
});

let txClient = null;   // выделенный клиент на время транзакции

// ответ кладётся в общий буфер (данные — ДО взведения флага), чтобы главный поток
// мог забрать его синхронно, не отдавая управление циклу событий
const signal = new Int32Array(workerData.sab, 0, 2);       // [0] флаг, [1] длина ответа
const out = new Uint8Array(workerData.sab, 8);
const CAP = workerData.sab.byteLength - 8;

parentPort.on("message", async m => {
  const done = j => {
    const str = Buffer.from(JSON.stringify({ id: m.id, ...j }), "utf8");
    if (str.length > CAP) str = Buffer.from(JSON.stringify({ id: m.id, error: "Ответ базы слишком велик" }), "utf8");
    out.set(str);
    Atomics.store(signal, 1, str.length);
    Atomics.store(signal, 0, 1);   // флаг — последним: «флаг = 1» значит «данные готовы»
    Atomics.notify(signal, 0);
  };
  try {
    if (m.type === "begin") {
      if (!txClient) txClient = await pool.connect();
      await txClient.query("BEGIN");
      return done({});
    }
    if (m.type === "commit") {
      if (txClient) { await txClient.query("COMMIT"); txClient.release(); txClient = null; }
      return done({});
    }
    if (m.type === "rollback") {
      if (txClient) { try { await txClient.query("ROLLBACK"); } catch (e) {} txClient.release(); txClient = null; }
      return done({});
    }
    if (m.type === "exec") {
      await (txClient || pool).query(m.sql);
      return done({});
    }
    // обычный запрос; в транзакции — через её клиент
    const res = txClient ? await txClient.query(m.sql, m.params || []) : await pool.query(m.sql, m.params || []);
    done({ rows: res.rows, rowCount: res.rowCount });
  } catch (e) {
    done({ error: e.message, code: e.code });
  }
});
