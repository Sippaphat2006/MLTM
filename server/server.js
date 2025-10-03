const express = require('express');
const cors = require('cors');

//const databases = require('./db');
//onst pool = databases.db_mltm;

// API router
const serverRouter = require('./server_router');

const app = express();
//const HOST = '192.168.0.233';

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('MLTM server is up'));
app.use('/api', serverRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// // only listen after DB is reachable
// (async () => {
//   try {
//     if (!pool) throw new Error('db_mltm pool not found. Export it in ./db');
//     await pool.query('SELECT 1');           
//     console.log('[DB] Connected');
//     app.listen(PORT, () => {
//       console.log(`MLTM API running on http://${HOST}:${PORT}`);
//       console.log(`Try:  http://${HOST}:${PORT}/api/health/db`);
//     });
//   } catch (e) {
//     console.error('[DB] Connection failed:', e.code, e.errno, e.sqlMessage || e.message);
//     process.exit(1);
//   }
// })();


// // server.js — MLTM API (standalone, no db.js)

// // 1) Deps
// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const mysql = require('mysql2/promise');

// // 2) DB pool (env first, then local defaults)
// const pool = mysql.createPool({
//   host: process.env.DB_HOST || 'localhost',
//   user: process.env.DB_USER || 'root',
//   password: process.env.DB_PASS || 'castem300',
//   database: process.env.DB_NAME || 'mltm',
//   waitForConnections: true,
//   connectionLimit: 10,
// });

// // 3) App
// const app = express();
// app.use(cors());
// app.use(express.json());

// async function getMachineIdByCode(code) {
//   const [rows] = await pool.query('SELECT id FROM machines WHERE code=?', [code]);
//   return rows.length ? rows[0].id : null;
// }

// // -------------------------
// // API ROUTES (base: /api)
// // -------------------------

// // List machines
// // GET /api/machines
// app.get('/api/machines', async (req, res) => {
//   try {
//     const [rows] = await pool.query('SELECT id, code, name FROM machines ORDER BY id');
//     res.json(rows);
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// // Current status (open interval)
// // GET /api/machines/:code/status/current
// app.get('/api/machines/:code/status/current', async (req, res) => {
//   try {
//     const machineId = await getMachineIdByCode(req.params.code);
//     if (!machineId) return res.status(404).json({ error: 'machine not found' });

//     const [rows] = await pool.query(
//       `SELECT sc.name AS color, sc.hex, ms.start_time
//        FROM machine_status ms
//        JOIN status_colors sc ON sc.id = ms.color_id
//        WHERE ms.machine_id=? AND ms.end_time IS NULL
//        ORDER BY ms.start_time DESC
//        LIMIT 1`,
//       [machineId]
//     );

//     res.json(rows[0] || { color: 'off', hex: '#9E9E9E' });
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// // Daily distribution (seconds per color)
// // GET /api/machines/:code/status/by-date?date=YYYY-MM-DD
// app.get('/api/machines/:code/status/by-date', async (req, res) => {
//   try {
//     const { code } = req.params;
//     const date = req.query.date;
//     if (!date) return res.status(400).json({ error: 'date required' });

//     const sql = `WITH t AS (
//         SELECT sc.name AS color,
//                SUM(TIMESTAMPDIFF(SECOND,
//                    GREATEST(ms.start_time, ?),
//                    LEAST(COALESCE(ms.end_time, NOW()), DATE_ADD(?, INTERVAL 1 DAY))
//                )) AS seconds
//         FROM machine_status ms
//         JOIN status_colors sc ON sc.id = ms.color_id
//         JOIN machines m ON m.id = ms.machine_id
//         WHERE m.code = ?
//           AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
//           AND COALESCE(ms.end_time, NOW()) > ?
//         GROUP BY sc.name
//       )
//       SELECT 'green' AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
//       UNION ALL SELECT 'yellow', COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
//       UNION ALL SELECT 'red',    COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t
//       UNION ALL SELECT 'blue',   COALESCE(MAX(CASE WHEN color='blue'   THEN seconds END),0) FROM t
//       UNION ALL SELECT 'off',    COALESCE(MAX(CASE WHEN color='off'    THEN seconds END),0) FROM t`;

//     const [rows] = await pool.query(sql, [date, date, code, date, date]);
//     res.json(rows);
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// // Weekly (7 days from week_start)
// // GET /api/machines/:code/status/weekly?week_start=YYYY-MM-DD
// app.get('/api/machines/:code/status/weekly', async (req, res) => {
//   try {
//     const { code } = req.params;
//     const weekStart = req.query.week_start;
//     if (!weekStart) return res.status(400).json({ error: 'week_start required' });

//     const out = [];
//     for (let i = 0; i < 7; i++) {
//       const d = new Date(weekStart);
//       d.setDate(d.getDate() + i);
//       const date = d.toISOString().slice(0, 10);

//       const sql = `WITH t AS (
//           SELECT sc.name AS color,
//                  SUM(TIMESTAMPDIFF(SECOND,
//                      GREATEST(ms.start_time, ?),
//                      LEAST(COALESCE(ms.end_time, NOW()), DATE_ADD(?, INTERVAL 1 DAY))
//                  )) AS seconds
//           FROM machine_status ms
//           JOIN status_colors sc ON sc.id = ms.color_id
//           JOIN machines m ON m.id = ms.machine_id
//           WHERE m.code = ?
//             AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
//             AND COALESCE(ms.end_time, NOW()) > ?
//           GROUP BY sc.name
//         )
//         SELECT 'green' AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
//         UNION ALL SELECT 'yellow', COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
//         UNION ALL SELECT 'red',    COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t
//         UNION ALL SELECT 'blue',   COALESCE(MAX(CASE WHEN color='blue'   THEN seconds END),0) FROM t
//         UNION ALL SELECT 'off',    COALESCE(MAX(CASE WHEN color='off'    THEN seconds END),0) FROM t`;

//       const [rows] = await pool.query(sql, [date, date, code, date, date]);
//       out.push({ date, buckets: rows });
//     }
//     res.json(out);
//   } catch (e) {
//     res.status(500).json({ error: e.message });
//   }
// });

// // Ingest a status interval (use later when devices post)
// // POST /api/ingest
// // Body: { machine_code, color, started_at, ended_at? }
// app.post('/api/ingest', async (req, res) => {
//   const { machine_code, color, started_at, ended_at } = req.body || {};
//   if (!machine_code || !color || !started_at)
//     return res.status(400).json({ error: 'missing fields' });

//   const conn = await pool.getConnection();
//   try {
//     await conn.beginTransaction();

//     const [mRows] = await conn.query('SELECT id FROM machines WHERE code=?', [machine_code]);
//     if (!mRows.length) throw new Error('machine not found');

//     const [cRows] = await conn.query('SELECT id FROM status_colors WHERE name=?', [color]);
//     if (!cRows.length) throw new Error('bad color');

//     await conn.query(
//       'INSERT INTO machine_status(machine_id,color_id,start_time,end_time) VALUES (?,?,?,?)',
//       [mRows[0].id, cRows[0].id, started_at, ended_at || null]
//     );

//     await conn.commit();
//     res.json({ ok: true });
//   } catch (e) {
//     await conn.rollback();
//     res.status(400).json({ error: e.message });
//   } finally {
//     conn.release();
//   }
// });

// // 4) Start
// const PORT = process.env.PORT || 8081;
// app.listen(PORT, () => console.log(`MLTM API on http://localhost:${PORT}`));

