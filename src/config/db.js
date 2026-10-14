const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL no definido (revisa .env)');
    }
    const url = process.env.DATABASE_URL;
    // Supabase/Neon exigen SSL; el Postgres local de Docker no.
    const isLocal = /localhost|127\.0\.0\.1/.test(url);
    pool = new Pool({
      connectionString: url,
      max: 10,
      ...(isLocal
        ? {}
        : { ssl: { rejectUnauthorized: false } }),
    });
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withTransaction, closePool };
