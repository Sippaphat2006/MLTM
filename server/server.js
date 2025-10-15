const express = require('express');
const cors = require('cors');
const path = require('path');

process.env.UNKNOWN_STOPS_TIMER = process.env.UNKNOWN_STOPS_TIMER ?? 'true';

// API router
const serverRouter = require('./server_router');
const { startInactivityWatchdog } = require('./server_controller');
startInactivityWatchdog();

const app = express();
//const HOST = '192.168.0.233';

app.use(cors());
app.use('/api', express.json({ limit: '4kb' }));

app.get('/health', (req, res) => res.send('MLTM server is up'));
app.use('/api', serverRouter);

app.use('/api', (err, req, res, next) => {
  if (err && err.type === 'request.aborted') {
    // client gave up during body read — nothing to do
    if (!res.headersSent) try { res.end(); } catch (_) {}
    return;
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).end();
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  next(err);
});

const fs = require('fs');

// Serve the whole public folder at the root (so /assets/... also works)
app.use(express.static(path.join(__dirname, 'public')));
// Keep the explicit /assets alias too
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));


const PORT = process.env.PORT || 3001;
const srv = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// keep these conservative so hung clients don’t tie up sockets
srv.requestTimeout   = 20000; // 20s
srv.headersTimeout   = 17000; // 17s
srv.keepAliveTimeout = 5000;  // 5s