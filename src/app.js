const express = require('express');
const cors = require('cors');
const { notFound, errorHandler } = require('./middleware/error');
const routes = require('./routes');

function createApp() {
  const app = express();

  app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', app: 'colibri', timestamp: new Date().toISOString() });
  });

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
