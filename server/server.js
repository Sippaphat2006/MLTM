const express = require('express');
const cors = require('cors');

// API router
const serverRouter = require('./server_router');
const app = express();
//const HOST = '192.168.0.233';

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => res.send('MLTM server is up'));
app.use('/api', serverRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
