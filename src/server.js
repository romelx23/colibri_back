require('dotenv').config();
const http = require('http');
const { createApp } = require('./app');
const { attachDuelServer } = require('./ws/duelServer');
const { getPool, closePool } = require('./config/db');
const { migrate } = require('../db/migrate');

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  // falla temprano si la DB no responde
  const pool = getPool();
  await pool.query('SELECT 1');

  // esquema al día antes de aceptar conexiones (idempotente y registrada)
  await migrate(pool);

  const app = createApp();
  const server = http.createServer(app);
  attachDuelServer(server);

  server.listen(PORT, () => {
    console.log(`Colibrí API en http://localhost:${PORT}`);
    console.log(`Duelos en   ws://localhost:${PORT}/ws`);
  });

  const shutdown = async () => {
    console.log('\nCerrando…');
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('No se pudo iniciar:', err.message);
  process.exit(1);
});
