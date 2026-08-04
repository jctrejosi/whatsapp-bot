// ============================================================================
// PostgreSQL connection pool — shared across bot-manager and settings.
// Uses DATABASE_URL env var (same DB as knowledge-service).
// ============================================================================
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/knowledge_db';

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('DB pool error:', err.message);
});

/**
 * Get a client from the pool. Use with try/finally to release.
 *   const client = await getClient();
 *   try { ... } finally { client.release(); }
 */
async function getClient() {
  return pool.connect();
}

/**
 * Run a query with automatic client acquisition/release.
 */
async function query(text, params) {
  const client = await getClient();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

module.exports = { pool, getClient, query, DATABASE_URL };
