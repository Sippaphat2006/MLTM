// db_connection.js — quick MySQL/MariaDB connectivity + schema check
// Assumes ./db exports: { db_mltm: mysql2 promise pool }

(async () => {
  try {
    const databases = require('./db');          // <- your pool wrapper
    if (!databases || !databases.db_mltm) {
      console.error('[ERR] ./db did not export db_mltm. Did you do: module.exports = databases; ?');
      process.exit(1);
    }

    const pool = databases.db_mltm;

    // 1) ping
    const [ping] = await pool.query('SELECT 1 AS ok');
    if (!ping || !ping[0] || ping[0].ok !== 1) throw new Error('Ping failed');

    // 2) env info
    const [info] = await pool.query('SELECT @@version AS version, DATABASE() AS db, CURRENT_USER() AS user');
    console.log('----------------------------------------');
    console.log(' DB Connected');
    console.log('----------------------------------------');
    console.log(` version : ${info[0].version}`);
    console.log(` database: ${info[0].db}`);
    console.log(` user    : ${info[0].user}`);

    // 3) required tables check
    const required = ['machines', 'machine_status', 'status_colors'];
    const [tables] = await pool.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name IN (?,?,?)`,
      required
    );
    const present = new Set(tables.map(t => t.table_name));
    console.log('----------------------------------------');
    console.log(' Tables:');
    for (const t of required) {
      console.log(`  - ${t}: ${present.has(t) ? 'OK' : 'MISSING'}`);
    }

    // 4) simple sample reads (won’t throw if table missing)
    try {
      const [m] = await pool.query('SELECT COUNT(*) AS cnt FROM machines');
      console.log(` machines rows     : ${m[0].cnt}`);
    } catch { /* ignore */ }

    try {
      const [c] = await pool.query('SELECT COUNT(*) AS cnt FROM status_colors');
      console.log(` status_colors rows: ${c[0].cnt}`);
    } catch { /* ignore */ }

    console.log('----------------------------------------');
    await pool.end?.(); // optional (works if using a single connection; pool will drain on exit)
    process.exit(0);
  } catch (e) {
    // print detailed mysql2 error info if present
    const code = e.code || '';
    const errno = e.errno != null ? ` errno=${e.errno}` : '';
    const msg = e.sqlMessage || e.message || e.toString();
    console.error('[DB] Connection failed:', code + errno, '\n', msg);

    // common hints
    if (code === 'ECONNREFUSED') {
      console.error('Hint: MySQL service not running, wrong host/port, or blocked by firewall.');
    } else if (code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('Hint: Bad user/password. Try mysql -h 127.0.0.1 -u <user> -p to verify.');
    } else if (code === 'ER_BAD_DB_ERROR') {
      console.error('Hint: Database does not exist. Create it and load schema.sql.');
    } else if (code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
      console.error('Hint: Switch user to mysql_native_password or update client auth.');
    }

    process.exit(1);
  }
})();
