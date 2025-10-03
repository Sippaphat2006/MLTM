//==============================
//  MLTM API - server_controller.js
//==============================

const db = require('./db');
const { format } = require('date-fns');

// ---------- helpers ----------
const _getMachineId = async (code) => {
  const rows = await db.query('db_mltm', 'SELECT id FROM machines WHERE code=?', [code]);
  return rows.length ? rows[0].id : null;
};

// ---------- 0) Health / metadata ----------
const healthDb = (req, res) => {
  db.query('db_mltm', 'SELECT 1 AS ok')
    .then(rows => res.status(200).json({ ok: true, db: rows[0].ok }))
    .catch(err => {
      console.error('healthDb error:', err);
      res.status(500).json({ ok: false, error: err.message });
    });
};

const getColors = (req, res) => {
  db.query('db_mltm', 'SELECT id, name, hex FROM status_colors ORDER BY id')
    .then(rows => res.status(200).json(rows))
    .catch(err => {
      console.error('getColors error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
};

const getMachines = (req, res) => {
  db.query('db_mltm', 'SELECT id, code, name FROM machines ORDER BY id')
    .then(rows => res.status(200).json(rows))
    .catch(err => {
      console.error('getMachines error:', err);
      res.status(500).json({ error: 'Internal server error' });
    });
};

// ---------- 1) Per-machine status ----------
const getMachineCurrentStatus = async (req, res) => {
  try {
    const code = req.params.code;
    const machineId = await _getMachineId(code);
    if (!machineId) return res.status(404).json({ error: 'machine not found' });

    const rows = await db.query(
      'db_mltm',
      `SELECT sc.name AS color, sc.hex, ms.start_time
       FROM machine_status ms
       JOIN status_colors sc ON sc.id = ms.color_id
       WHERE ms.machine_id=? AND ms.end_time IS NULL
       ORDER BY ms.start_time DESC
       LIMIT 1`,
      [machineId]
    );

    res.status(200).json(rows[0] || { color: 'off', hex: '#9E9E9E' });
  } catch (err) {
    console.error('getMachineCurrentStatus error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getMachineByDate = async (req, res) => {
  try {
    const code = req.params.code;
    const date = req.query.date; // 'YYYY-MM-DD'
    if (!date) return res.status(400).json({ error: 'date required' });

    const sql = `WITH t AS (
      SELECT sc.name AS color,
             SUM(TIMESTAMPDIFF(SECOND,
                 GREATEST(ms.start_time, ?),
                 LEAST(COALESCE(ms.end_time, NOW()), DATE_ADD(?, INTERVAL 1 DAY))
             )) AS seconds
      FROM machine_status ms
      JOIN status_colors sc ON sc.id = ms.color_id
      JOIN machines m ON m.id = ms.machine_id
      WHERE m.code = ?
        AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
        AND COALESCE(ms.end_time, NOW()) > ?
      GROUP BY sc.name
    )
    SELECT 'green' AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
    UNION ALL SELECT 'yellow', COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
    UNION ALL SELECT 'red',    COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t
    UNION ALL SELECT 'blue',   COALESCE(MAX(CASE WHEN color='blue'   THEN seconds END),0) FROM t
    UNION ALL SELECT 'off',    COALESCE(MAX(CASE WHEN color='off'    THEN seconds END),0) FROM t`;

    const rows = await db.query('db_mltm', sql, [date, date, code, date, date]);
    res.status(200).json(rows);
  } catch (err) {
    console.error('getMachineByDate error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getMachineTimeline = async (req, res) => {
  try {
    const code = req.params.code;
    const date = req.query.date; // 'YYYY-MM-DD'
    if (!date) return res.status(400).json({ error: 'date required' });

    const rows = await db.query(
      'db_mltm',
      `SELECT sc.name AS color, sc.hex, ms.start_time, ms.end_time
       FROM machine_status ms
       JOIN status_colors sc ON sc.id = ms.color_id
       JOIN machines m ON m.id = ms.machine_id
       WHERE m.code = ?
         AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
         AND COALESCE(ms.end_time, NOW()) > ?
       ORDER BY ms.start_time ASC`,
      [code, date, date]
    );

    res.status(200).json(rows);
  } catch (err) {
    console.error('getMachineTimeline error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

const getMachineWeekly = async (req, res) => {
  try {
    const code = req.params.code;
    const weekStart = req.query.week_start; // 'YYYY-MM-DD'
    if (!weekStart) return res.status(400).json({ error: 'week_start required' });

    const sql = `WITH t AS (
      SELECT sc.name AS color,
             SUM(TIMESTAMPDIFF(SECOND,
                 GREATEST(ms.start_time, ?),
                 LEAST(COALESCE(ms.end_time, NOW()), DATE_ADD(?, INTERVAL 1 DAY))
             )) AS seconds
      FROM machine_status ms
      JOIN status_colors sc ON sc.id = ms.color_id
      JOIN machines m ON m.id = ms.machine_id
      WHERE m.code = ?
        AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
        AND COALESCE(ms.end_time, NOW()) > ?
      GROUP BY sc.name
    )
    SELECT 'green' AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
    UNION ALL SELECT 'yellow', COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
    UNION ALL SELECT 'red',    COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t
    UNION ALL SELECT 'blue',   COALESCE(MAX(CASE WHEN color='blue'   THEN seconds END),0) FROM t
    UNION ALL SELECT 'off',    COALESCE(MAX(CASE WHEN color='off'    THEN seconds END),0) FROM t`;

    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      const rows = await db.query('db_mltm', sql, [date, date, code, date, date]);
      out.push({ date, buckets: rows });
    }
    res.status(200).json(out);
  } catch (err) {
    console.error('getMachineWeekly error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------- 2) Overview ----------
const getOverviewToday = async (req, res) => {
  try {
    const today = format(new Date(), 'yyyy-MM-dd');

    const machines = await db.query('db_mltm', 'SELECT id, code, name FROM machines ORDER BY id');
    const results = [];

    for (const m of machines) {
      const current = await db.query(
        'db_mltm',
        `SELECT sc.name AS color, sc.hex, ms.start_time
         FROM machine_status ms
         JOIN status_colors sc ON sc.id = ms.color_id
         WHERE ms.machine_id=? AND ms.end_time IS NULL
         ORDER BY ms.start_time DESC LIMIT 1`,
        [m.id]
      );

      const buckets = await db.query(
        'db_mltm',
        `WITH t AS (
          SELECT sc.name AS color,
                 SUM(TIMESTAMPDIFF(SECOND,
                     GREATEST(ms.start_time, ?),
                     LEAST(COALESCE(ms.end_time, NOW()), DATE_ADD(?, INTERVAL 1 DAY))
                 )) AS seconds
          FROM machine_status ms
          JOIN status_colors sc ON sc.id = ms.color_id
          WHERE ms.machine_id = ?
            AND ms.start_time < DATE_ADD(?, INTERVAL 1 DAY)
            AND COALESCE(ms.end_time, NOW()) > ?
          GROUP BY sc.name
        )
        SELECT 'green' AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
        UNION ALL SELECT 'yellow', COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
        UNION ALL SELECT 'red',    COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t
        UNION ALL SELECT 'blue',   COALESCE(MAX(CASE WHEN color='blue'   THEN seconds END),0) FROM t
        UNION ALL SELECT 'off',    COALESCE(MAX(CASE WHEN color='off'    THEN seconds END),0) FROM t`,
        [today, today, m.id, today, today]
      );

      results.push({
        machine: { id: m.id, code: m.code, name: m.name },
        current: current[0] || { color: 'off', hex: '#9E9E9E' },
        buckets
      });
    }

    res.status(200).json({ date: today, overview: results });
  } catch (err) {
    console.error('getOverviewToday error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

// ---------- 3) Ingest ----------
const postIngest = async (req, res) => {
  try {
    const { machine_code, color, started_at, ended_at } = req.body || {};
    if (!machine_code || !color || !started_at) {
      return res.status(400).json({ error: 'missing fields' });
    }

    const mid = await _getMachineId(machine_code);
    if (!mid) return res.status(404).json({ error: 'machine not found' });

    const colorRow = await db.query('db_mltm', 'SELECT id FROM status_colors WHERE name=?', [color]);
    if (!colorRow.length) return res.status(400).json({ error: 'bad color' });

    await db.query(
      'db_mltm',
      'INSERT INTO machine_status(machine_id,color_id,start_time,end_time) VALUES (?,?,?,?)',
      [mid, colorRow[0].id, started_at, ended_at || null]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('postIngest error:', err);
    res.status(400).json({ error: err.message });
  }
};

// Close previous open interval and start a new one at NOW()
const postIngestNow = async (req, res) => {
  try {
    const { machine_code, color } = req.body || {};
    if (!machine_code || !color) {
      return res.status(400).json({ error: 'missing fields' });
    }

    const mid = await _getMachineId(machine_code);
    if (!mid) return res.status(404).json({ error: 'machine not found' });

    const colorRow = await db.query('db_mltm', 'SELECT id FROM status_colors WHERE name=?', [color]);
    if (!colorRow.length) return res.status(400).json({ error: 'bad color' });

    // close any open interval at NOW()
    await db.query(
      'db_mltm',
      'UPDATE machine_status SET end_time = NOW() WHERE machine_id=? AND end_time IS NULL',
      [mid]
    );

    // open a new interval
    await db.query(
      'db_mltm',
      'INSERT INTO machine_status(machine_id,color_id,start_time,end_time) VALUES (?, ?, NOW(), NULL)',
      [mid, colorRow[0].id]
    );

    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('postIngestNow error:', err);
    res.status(400).json({ error: err.message });
  }
};


module.exports = {
  // health/meta
  healthDb,
  getColors,
  getMachines,

  // machine status
  getMachineCurrentStatus,
  getMachineByDate,
  getMachineTimeline,
  getMachineWeekly,

  // dashboards
  getOverviewToday,

  // ingest
  postIngest,
  postIngestNow,

};
