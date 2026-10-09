process.env.JWT_SECRET = process.env.JWT_SECRET || 'colibri-test-secret';

const { Client, Pool } = require('pg');

const MAIN_URL =
  process.env.DATABASE_URL ||
  'postgres://colibri:colibri_secret@localhost:5433/colibri';
const TEST_URL =
  process.env.TEST_DATABASE_URL ||
  'postgres://colibri:colibri_secret@localhost:5433/colibri_test';

// Crea la DB de test (si no existe), la migra, la siembra y la deja vacía.
async function prepare() {
  const admin = new Client({ connectionString: MAIN_URL });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['colibri_test']);
  if (!exists.rows.length) await admin.query('CREATE DATABASE colibri_test');
  await admin.end();

  process.env.DATABASE_URL = TEST_URL;

  const pool = new Pool({ connectionString: TEST_URL });
  const { migrate } = require('../../db/migrate');
  const { seed } = require('../../db/seed');
  await migrate(pool);
  await seed(pool);
  await pool.query(
    'TRUNCATE duel_answers, duels, session_events, players RESTART IDENTITY CASCADE'
  );

  const { closePool } = require('../../src/config/db');
  await closePool();
  await pool.end();
}

module.exports = { prepare, TEST_URL };
