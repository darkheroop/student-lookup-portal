const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.DATABASE_POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL ||
    process.env.PG_CONNECTION_STRING
  );
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 100000, 64, 'sha512')
    .toString('hex');
  return `pbkdf2:sha512:100000:${salt}:${hash}`;
}

async function runMigrations(customConnectionString) {
  const connectionString = customConnectionString || getDatabaseUrl();
  if (!connectionString) {
    console.log('[Migration] No DATABASE_URL configured. Skipping PostgreSQL migration.');
    return { success: false, skipped: true, reason: 'NO_DATABASE_URL' };
  }

  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  let client = null;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Advisory lock ensures only one worker runs migrations at a time
    await client.query('SELECT pg_advisory_xact_lock(84920491)');

    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');
    await client.query(schemaSql);

    // Bootstrap default administrator credentials if none exist
    const adminCountRes = await client.query('SELECT COUNT(*) as count FROM admin_users');
    if (parseInt(adminCountRes.rows[0]?.count || '0', 10) === 0) {
      const defaultUser = process.env.ADMIN_USERNAME || 'inexpert_trifler';
      const defaultPass = process.env.ADMIN_PASSWORD || 'om sai 0987654321';
      const passwordHash = hashPassword(defaultPass);

      await client.query(
        'INSERT INTO admin_users (username, password_hash, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (username) DO NOTHING',
        [defaultUser, passwordHash]
      );
      console.log(`[Migration] Initialized bootstrap admin user in Neon: "${defaultUser}"`);
    }

    await client.query('COMMIT');
    console.log('[Migration] Neon PostgreSQL database migrations applied successfully.');
    return { success: true };
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
    }
    console.error('[Migration] Failed to run database migrations:', err.message);
    throw err;
  } finally {
    if (client) {
      client.release();
    }
    await pool.end();
  }
}

// Allow direct CLI execution
if (require.main === module) {
  runMigrations()
    .then((res) => {
      if (res.success) {
        console.log('Migration finished successfully.');
        process.exit(0);
      } else {
        console.log('Migration skipped:', res.reason);
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = {
  runMigrations,
  getDatabaseUrl,
};
