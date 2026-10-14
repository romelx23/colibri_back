const express = require('express');
const cors = require('cors');
const { notFound, errorHandler } = require('./middleware/error');
const routes = require('./routes');

function createApp() {
  const app = express();

  // CORS: '*' en dev. En producción, lista exacta de orígenes web separados
  // por coma (p. ej. https://colibri.app,https://www.colibri.app).
  // La app móvil no aplica CORS: eso lo controla solo el navegador.
  const allowedOrigins = (process.env.CORS_ORIGIN || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.use(cors({ origin: allowedOrigins.length > 1 ? allowedOrigins : allowedOrigins[0] || '*' }));
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
