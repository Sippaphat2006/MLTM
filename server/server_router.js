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
router.get('/machines/:code/status/by-date', ctrl.getMachineByDate);
router.get('/machines/:code/timeline/span', ctrl.getMachineTimelineSpan);
router.get('/machines/:code/touch/timeline/span', ctrl.getTouchTimelineSpan);
router.get('/machines/:code/status/by-month', ctrl.getMachineByMonth);



// Overview
router.get('/overview/today', ctrl.getOverviewToday);

// Ingest
router.post('/ingest', ctrl.postIngest);
router.post('/ingest/now', ctrl.postIngestNow);
router.post('/ingest/upsert', ctrl.postUpsertStatus);



module.exports = router;
