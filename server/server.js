const express = require('express');
const cors = require('cors');

process.env.UNKNOWN_STOPS_TIMER = process.env.UNKNOWN_STOPS_TIMER ?? 'true';

// API router
const serverRouter = require('./server_router');
const { startInactivityWatchdog } = require('./server_controller');
startInactivityWatchdog();

const app = express();
//const HOST = '192.168.0.233';

const path = require('path');
app.use('/public/assets', express.static(path.join(__dirname, 'public', 'assets')));


app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('MLTM server is up'));
app.use('/api', serverRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
