//==============================
//  MLTM API - server_router.js
//==============================

const express = require('express');
const router = express.Router();
const ctrl = require('./server_controller');

// Health / metadata
router.get('/health/db', ctrl.healthDb);
router.get('/colors', ctrl.getColors);
router.get('/machines', ctrl.getMachines);

// Per-machine
router.get('/machines/:code/status/current', ctrl.getMachineCurrentStatus);
router.get('/machines/:code/status/by-date', ctrl.getMachineByDate);
router.get('/machines/:code/timeline', ctrl.getMachineTimeline);
router.get('/machines/:code/status/weekly', ctrl.getMachineWeekly);

// Overview
router.get('/overview/today', ctrl.getOverviewToday);

// Ingest
router.post('/ingest', ctrl.postIngest);
router.post('/ingest/now', ctrl.postIngestNow);
router.post('/ingest/upsert', ctrl.postUpsertStatus);



module.exports = router;
