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

// --- config toggles (no .env) ---
const UNKNOWN_STOPS_TIMER = true;      // close open interval if sensor says "unknown"
const INACTIVITY_CLOSE_MS = 4000;      // if no ingest for this long, auto-close at last_seen
const WATCHDOG_TICK_MS    = 1000;      // how often to check inactivity
const ALLOWED = ['green','yellow','red'];

// normalize names coming from devices
function normalize3(name){
  const s = String(name||'').toLowerCase().trim();
  if (s==='amber') return 'yellow';
  if (s==='g') return 'green';
  if (s==='y') return 'yellow';
  if (s==='r') return 'red';
  return ALLOWED.includes(s) ? s : 'unknown';
}

async function closeOpenInterval(dbName, machineId, at=null){
  const open = await db.query(dbName,
    `SELECT id FROM machine_status
     WHERE machine_id=? AND end_time IS NULL
     ORDER BY start_time DESC LIMIT 1`, [machineId]);
  if (!open.length) return false;

  const params = [];
  let set = 'end_time=NOW()';
  if (at) { set = 'end_time=?'; params.push(at); }

  await db.query(dbName, `UPDATE machine_status SET ${set} WHERE id=?`, params.concat([open[0].id]));
  return true;
}

// --- last-seen tracker (in-memory) ---
const lastSeen = new Map();                   // machine_id -> ms since epoch
function touchMachine(mid){ lastSeen.set(mid, Date.now()); }

// exportable watchdog starter
async function _closeIfInactive(mid, lastTs){
  // close open row at the moment we last heard from the machine
  await closeOpenInterval('db_mltm', mid, new Date(lastTs));
}
function startInactivityWatchdog(){
  setInterval(async ()=>{
    const now = Date.now();
    for (const [mid, ts] of lastSeen.entries()){
      if (now - ts > INACTIVITY_CLOSE_MS){
        await _closeIfInactive(mid, ts);
        lastSeen.delete(mid);
      }
    }
  }, WATCHDOG_TICK_MS);
  (async function closeStaleOnBoot(){
    await db.query('db_mltm', `
      UPDATE machine_status
      SET end_time = NOW()
      WHERE end_time IS NULL
        AND start_time < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `);
  })();
}



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
// GET /machines/:code/status/current
// GET /machines/:code/status/current
const getMachineCurrentStatus = async (req, res) => {
  try {
    const code = req.params.code;
    const  m = await db.query('db_mltm', `SELECT id FROM machines WHERE code=? LIMIT 1`, [code]);
    if (!m.length) return res.status(404).json({ error:'machine not found' });

    const row = await db.query('db_mltm',
      `SELECT sc.name AS color, sc.hex, ms.start_time
       FROM machine_status ms
       JOIN status_colors sc ON sc.id = ms.color_id
       WHERE ms.machine_id=? AND ms.end_time IS NULL
       ORDER BY ms.start_time DESC LIMIT 1`, [m[0].id]);

    // IMPORTANT: when nothing open → return 'unknown'
    if (!row.length) return res.status(200).json(row[0] || { color: 'unknown', hex: '#9E9E9E' });
    res.status(200).json(row[0]);
  } catch (err) {
    console.error('getMachineCurrentStatus error:', err);
    res.status(500).json({ error:'Internal server error' });
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
      // current (fallback to unknown if no open interval)
      const currentRow = await db.query(
        'db_mltm',
        `SELECT sc.name AS color, sc.hex, ms.start_time
           FROM machine_status ms
           JOIN status_colors sc ON sc.id = ms.color_id
          WHERE ms.machine_id=? AND ms.end_time IS NULL
          ORDER BY ms.start_time DESC LIMIT 1`,
        [m.id]
      );
      const current = currentRow[0] || { color: 'unknown', hex: '#9E9E9E' };

      // daily buckets for *today* (only G/Y/R)
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
         SELECT 'green'  AS color, COALESCE(MAX(CASE WHEN color='green'  THEN seconds END),0) AS seconds FROM t
         UNION ALL
         SELECT 'yellow' AS color, COALESCE(MAX(CASE WHEN color='yellow' THEN seconds END),0) FROM t
         UNION ALL
         SELECT 'red'    AS color, COALESCE(MAX(CASE WHEN color='red'    THEN seconds END),0) FROM t`,
        [today, today, m.id, today, today]
      );

      results.push({ machine: { id: m.id, code: m.code, name: m.name }, current, buckets });
    }

    res.status(200).json({ date: today, overview: results });
  } catch (err) {
    console.error('getOverviewToday error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};


// ---------- 3) Ingest ----------
// POST /ingest  body: { machine_code, color, at? }
// POST /ingest   { machine_code, color, at? }
const postIngest = async (req, res) => {
  try {
    const { machine_code, color, at } = req.body || {};
    if (!machine_code) return res.status(400).json({ error:'machine_code required' });

    const m = await db.query('db_mltm', `SELECT id FROM machines WHERE code=? LIMIT 1`, [machine_code]);
    if (!m.length) return res.status(404).json({ error:'machine not found' });
    const machineId = m[0].id;
    touchMachine(machineId);

    const norm = normalize3(color);
    const ts   = at ? new Date(at) : null;

    if (UNKNOWN_STOPS_TIMER && norm === 'unknown') {
      const closed = await closeOpenInterval('db_mltm', machineId, ts);
      return res.status(200).json({ ok:true, action:'closed_on_unknown', closed });
    }
    if (!ALLOWED.includes(norm)) {
      const closed = await closeOpenInterval('db_mltm', machineId, ts);
      return res.status(200).json({ ok:true, action:'closed_on_unknown_alias', closed });
    }

    const c = await db.query('db_mltm', `SELECT id FROM status_colors WHERE name=? LIMIT 1`, [norm]);
    if (!c.length) return res.status(400).json({ error:`status_colors missing for ${norm}` });
    const colorId = c[0].id;

    const cur = await db.query('db_mltm',
      `SELECT id, color_id FROM machine_status
       WHERE machine_id=? AND end_time IS NULL
       ORDER BY start_time DESC LIMIT 1`, [machineId]);

    if (cur.length && cur[0].color_id === colorId) {
      return res.status(200).json({ ok:true, action:'noop_same_color' });
    }

    if (cur.length) await closeOpenInterval('db_mltm', machineId, ts);

    if (ts) {
      await db.query('db_mltm',
        `INSERT INTO machine_status (machine_id, color_id, start_time) VALUES (?,?,?)`,
        [machineId, colorId, ts]);
    } else {
      await db.query('db_mltm',
        `INSERT INTO machine_status (machine_id, color_id, start_time) VALUES (?,?,NOW())`,
        [machineId, colorId]);
    }
    res.status(200).json({ ok:true, action:'switched_color', color:norm });
  } catch (err) {
    console.error('postIngest error:', err);
    res.status(500).json({ error:'Internal server error' });
  }
};



// Close previous open interval and start a new one at NOW()
// POST /ingest/now  body: { machine_code, color }
// POST /ingest/now   { machine_code, color }
// POST /ingest/now  { machine_code, color }
// POST /ingest/now  { machine_code, color }
const postIngestNow = async (req, res) => {
  try {
    const { machine_code, color } = req.body || {};
    if (!machine_code || !color) return res.status(400).json({ error: 'missing fields' });

    // get machine id
    const m = await db.query('db_mltm', `SELECT id FROM machines WHERE code=? LIMIT 1`, [machine_code]);
    if (!m.length) return res.status(404).json({ error: 'machine not found' });
    const mid = m[0].id;
    touchMachine(mid); // <-- make watchdog know this machine is alive


    const norm = normalize3(color);

    // ⬇️ IMPORTANT: short-circuit unknown BEFORE any status_colors lookup
    if (norm === 'unknown') {
      const closed = await closeOpenInterval('db_mltm', mid, null);
      return res.status(200).json({ ok: true, action: 'closed_on_unknown', closed });
    }

    // Any unrecognized string → also treat as unknown & close
    if (!ALLOWED.includes(norm)) {
      const closed = await closeOpenInterval('db_mltm', mid, null);
      return res.status(200).json({ ok: true, action: 'closed_on_unknown_alias', closed, raw: color });
    }

    // look up allowed color id
    const cRows = await db.query('db_mltm', `SELECT id FROM status_colors WHERE name=? LIMIT 1`, [norm]);
    if (!cRows.length) return res.status(500).json({ error: `status_colors missing for ${norm}` });
    const colorId = cRows[0].id;

    // same color already open → noop
    const cur = await db.query('db_mltm',
      `SELECT id, color_id
         FROM machine_status
        WHERE machine_id=? AND end_time IS NULL
        ORDER BY start_time DESC LIMIT 1`, [mid]);

    if (cur.length && cur[0].color_id === colorId) {
      return res.status(200).json({ ok: true, action: 'noop_same_color' });
    }

    // close previous open (if any) then open new interval
    if (cur.length) await closeOpenInterval('db_mltm', mid, null);

    await db.query('db_mltm',
      `INSERT INTO machine_status (machine_id, color_id, start_time, end_time)
       VALUES (?, ?, NOW(), NULL)`,
      [mid, colorId]);

    return res.status(201).json({ ok: true, action: 'opened', color: norm });
  } catch (err) {
    console.error('postIngestNow error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};


// POST /api/ingest/upsert
// body: { machine_code: "CNC1", color: "green" | "yellow" | "red", ts?: "YYYY-MM-DD HH:mm:ss" }
// POST /api/ingest/upsert
// body: { machine_code: "CNC1", color: "green"|"yellow"|"red", ts?: ISO }
const postUpsertStatus = async (req, res) => {
  try {
    const { machine_code, color, ts } = req.body || {};
    if (!machine_code || !color) return res.status(400).json({ error: 'missing fields' });

    // resolve machine
    const mrows = await db.query('db_mltm', 'SELECT id FROM machines WHERE code=? LIMIT 1', [machine_code]);
    if (!mrows.length) return res.status(404).json({ error: 'machine not found' });
    const mid = mrows[0].id;
    touchMachine(mid); // <-- heartbeat updates lastSeen too

    // resolve allowed color
    const crows = await db.query('db_mltm', 'SELECT id FROM status_colors WHERE name=? LIMIT 1', [color]);
    if (!crows.length) return res.status(400).json({ error: 'bad color' });
    const colorId = crows[0].id;

    // heartbeat seen
    touchMachine(mid);

    // find currently open interval
    const open = await db.query('db_mltm', `
      SELECT id, color_id FROM machine_status
      WHERE machine_id=? AND end_time IS NULL
      ORDER BY start_time DESC LIMIT 1
    `, [mid]);

    const now = ts ? new Date(ts) : new Date();

    if (open.length) {
      if (open[0].color_id === colorId) {
        // same color — keep it open, no DB write needed
        return res.json({ ok: true, action: 'heartbeat_noop' });
      }
      // different color (unexpected for heartbeat) — rotate rows safely
      await db.query('db_mltm', 'UPDATE machine_status SET end_time=? WHERE id=?', [now, open[0].id]);
      await db.query('db_mltm',
        'INSERT INTO machine_status (machine_id,color_id,start_time,end_time) VALUES (?,?,?,NULL)',
        [mid, colorId, now]);
      return res.status(201).json({ ok: true, action: 'rotated_on_diff_color' });
    }

    // no open row (e.g., after watchdog/server restart) — open new
    await db.query('db_mltm',
      'INSERT INTO machine_status (machine_id,color_id,start_time,end_time) VALUES (?,?,?,NULL)',
      [mid, colorId, now]);
    return res.status(201).json({ ok: true, action: 'opened_from_heartbeat' });

  } catch (err) {
    console.error('postUpsertStatus error:', err);
    return res.status(500).json({ error: 'Internal server error' });
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
  postUpsertStatus,

  //watchdog
  startInactivityWatchdog,

};
