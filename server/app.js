const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const actionRoutes = require('./routes/actionRoutes');

const app = express();

app.use(cors({ origin: true }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/ping', (req, res) => {
  res.status(200).json({ message: "I'm alive..." });
});

app.use('/action', actionRoutes);
app.use('/api/action', actionRoutes);

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'not_found',
      message: 'Route not found.'
    }
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({
    success: false,
    error: {
      code: 'internal_error',
      message: 'Unexpected server error.'
    }
  });
});

module.exports = app;
