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
app.use(express.json());

app.get('/', (req, res) => res.send('MLTM server is up'));
app.use('/api', serverRouter);

const fs = require('fs');

// Serve the whole public folder at the root (so /assets/... also works)
app.use(express.static(path.join(__dirname, 'public')));
// Keep the explicit /assets alias too
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets')));


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
