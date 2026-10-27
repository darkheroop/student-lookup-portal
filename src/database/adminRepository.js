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

// PostgreSQL Repository for production Neon persistence
class PostgresAdminRepository {
  constructor(connectionStringOrPool) {
    if (typeof connectionStringOrPool === 'string') {
      const globalAny = global;
      if (!globalAny.__neonPgPool) {
        const isLocal =
          connectionStringOrPool.includes('localhost') ||
          connectionStringOrPool.includes('127.0.0.1');

        globalAny.__neonPgPool = new Pool({
          connectionString: connectionStringOrPool,
          ssl: isLocal ? false : { rejectUnauthorized: false },
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000, // 10s gives Neon time to wake up if compute was suspended
          allowExitOnIdle: true,
        });

        globalAny.__neonPgPool.on('error', (err) => {
          console.error('[PostgreSQL] Unexpected pool client error:', err);
        });
      }
      this.pool = globalAny.__neonPgPool;
    } else {
      this.pool = connectionStringOrPool;
    }
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    if (PostgresAdminRepository.initPromise) {
      return PostgresAdminRepository.initPromise;
    }

    PostgresAdminRepository.initPromise = (async () => {
      let client = null;
      try {
        client = await this.pool.connect();
        await client.query('BEGIN');

        // Advisory transaction lock prevents concurrent schema migrations across serverless lambdas
        await client.query('SELECT pg_advisory_xact_lock(84920491)');

        // 1. Core api_keys table
        await client.query(`
          CREATE TABLE IF NOT EXISTS api_keys (
            id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(255),
            project_name VARCHAR(255) NOT NULL,
            description TEXT,
            key_prefix VARCHAR(32) NOT NULL,
            key_hash VARCHAR(128) NOT NULL UNIQUE,
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NULL,
            revoked_at TIMESTAMPTZ NULL,
            last_used_at TIMESTAMPTZ NULL,
            rate_limit_per_minute INTEGER NULL,
            total_requests BIGINT NOT NULL DEFAULT 0,
            successful_requests BIGINT NOT NULL DEFAULT 0,
            failed_requests BIGINT NOT NULL DEFAULT 0
          );
        `);

        // Non-destructive column additions
        await client.query(`
          ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name VARCHAR(255);
          ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;
        `);

        // 2. api_key_usage audit log table
        await client.query(`
          CREATE TABLE IF NOT EXISTS api_key_usage (
            id VARCHAR(64) PRIMARY KEY,
            key_id VARCHAR(64) NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
            endpoint VARCHAR(255) NOT NULL,
            status_code INTEGER NOT NULL,
            response_time_ms INTEGER NOT NULL,
            ip_address VARCHAR(64),
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        // 3. admin_users credentials table
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_users (
            username VARCHAR(100) PRIMARY KEY,
            password_hash VARCHAR(255) NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
        `);

        // 4. Indexes for efficient queries
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
          CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
          CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage(key_id);
          CREATE INDEX IF NOT EXISTS idx_api_key_usage_timestamp ON api_key_usage(timestamp DESC);
        `);

        // 5. Bootstrap default administrator credentials if none exist
        const adminCountRes = await client.query('SELECT COUNT(*) as count FROM admin_users');
        if (parseInt(adminCountRes.rows[0]?.count || '0', 10) === 0) {
          const defaultUser = process.env.ADMIN_USERNAME || 'inexpert_trifler';
          const defaultPass = process.env.ADMIN_PASSWORD || 'om sai 0987654321';
          const passwordHash = hashPassword(defaultPass);

          await client.query(
            'INSERT INTO admin_users (username, password_hash, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (username) DO NOTHING',
            [defaultUser, passwordHash]
          );
          console.log(`[PostgreSQL] Initialized bootstrap admin user in Neon: "${defaultUser}"`);
        }

        await client.query('COMMIT');
        this.initialized = true;
      } catch (err) {
        if (client) {
          await client.query('ROLLBACK').catch(() => {});
        }
        console.error('[PostgreSQL] Failed to initialize Neon PostgreSQL database schema:', err.message);
        throw err;
      } finally {
        if (client) {
          client.release();
        }
        PostgresAdminRepository.initPromise = null;
      }
    })();

    return PostgresAdminRepository.initPromise;
  }

  mapRowToRecord(row) {
    if (!row) return null;
    const toIso = (val) => {
      if (!val) return null;
      return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
    };

    return {
      id: row.id,
      name: row.name || row.project_name || '',
      projectName: row.project_name || row.name || '',
      description: row.description || '',
      keyPrefix: row.key_prefix,
      keyHash: row.key_hash,
      status: row.status,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      expiresAt: toIso(row.expires_at),
      revokedAt: toIso(row.revoked_at),
      lastUsedAt: toIso(row.last_used_at),
      rateLimitPerMinute: row.rate_limit_per_minute != null ? parseInt(row.rate_limit_per_minute, 10) : 60,
      totalRequests: parseInt(row.total_requests || '0', 10),
      successfulRequests: parseInt(row.successful_requests || '0', 10),
      failedRequests: parseInt(row.failed_requests || '0', 10),
    };
  }

  async getAdminUser(username) {
    if (!username) return null;
    await this.init();
    const res = await this.pool.query(
      'SELECT username, password_hash FROM admin_users WHERE LOWER(username) = LOWER($1)',
      [username.trim()]
    );
    if (res.rows.length === 0) return null;
    return {
      username: res.rows[0].username,
      passwordHash: res.rows[0].password_hash,
    };
  }

  async hasAnyAdminUser() {
    await this.init();
    const res = await this.pool.query('SELECT COUNT(*) as count FROM admin_users');
    return parseInt(res.rows[0]?.count || '0', 10) > 0;
  }

  async saveAdminUser(username, passwordHash) {
    await this.init();
    const query = `
      INSERT INTO admin_users (username, password_hash, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (username) DO UPDATE
      SET password_hash = $2, updated_at = NOW()
    `;
    await this.pool.query(query, [username.trim(), passwordHash]);
  }

  async updateAdminCredentials(oldUsername, newUsername, newPasswordHash) {
    await this.init();
    const existing = await this.getAdminUser(oldUsername);
    if (!existing) {
      throw new Error('Admin user not found.');
    }

    if (oldUsername.trim().toLowerCase() === newUsername.trim().toLowerCase()) {
      if (newPasswordHash) {
        await this.pool.query(
          'UPDATE admin_users SET password_hash = $1, updated_at = NOW() WHERE LOWER(username) = LOWER($2)',
          [newPasswordHash, oldUsername.trim()]
        );
      }
    } else {
      const hashToUse = newPasswordHash || existing.passwordHash;
      await this.pool.query('DELETE FROM admin_users WHERE LOWER(username) = LOWER($1)', [oldUsername.trim()]);
      await this.saveAdminUser(newUsername, hashToUse);
    }
  }

  async createKey(record) {
    await this.init();
    const query = `
      INSERT INTO api_keys (
        id, name, project_name, description, key_prefix, key_hash, status,
        created_at, updated_at, expires_at, revoked_at, last_used_at, rate_limit_per_minute,
        total_requests, successful_requests, failed_requests
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    `;

    await this.pool.query(query, [
      record.id,
      record.name || record.projectName,
      record.projectName || record.name,
      record.description || '',
      record.keyPrefix,
      record.keyHash,
      record.status || 'active',
      record.createdAt || new Date().toISOString(),
      record.updatedAt || new Date().toISOString(),
      record.expiresAt || null,
      record.revokedAt || null,
      record.lastUsedAt || null,
      record.rateLimitPerMinute || 60,
      record.totalRequests || 0,
      record.successfulRequests || 0,
      record.failedRequests || 0,
    ]);
  }

  async getKeyById(id) {
    await this.init();
    const res = await this.pool.query('SELECT * FROM api_keys WHERE id = $1', [id]);
    if (res.rows.length === 0) return null;
    return this.mapRowToRecord(res.rows[0]);
  }

  async getKeyByHash(hash) {
    await this.init();
    const res = await this.pool.query('SELECT * FROM api_keys WHERE key_hash = $1', [hash]);
    if (res.rows.length === 0) return null;
    return this.mapRowToRecord(res.rows[0]);
  }

  async listKeys(options = {}) {
    await this.init();
    const conditions = [];
    const values = [];
    let paramIndex = 1;

    if (options.search) {
      conditions.push(
        `(LOWER(project_name) LIKE $${paramIndex} OR LOWER(COALESCE(name, '')) LIKE $${paramIndex} OR LOWER(description) LIKE $${paramIndex} OR LOWER(key_prefix) LIKE $${paramIndex} OR LOWER(id) LIKE $${paramIndex})`
      );
      values.push(`%${options.search.toLowerCase()}%`);
      paramIndex++;
    }

    if (options.status && options.status !== 'all') {
      conditions.push(`status = $${paramIndex}`);
      values.push(options.status);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await this.pool.query(`SELECT COUNT(*) as count FROM api_keys ${whereClause}`, values);
    const total = parseInt(countRes.rows[0]?.count || '0', 10);

    const limit = options.limit ? Math.min(100, Math.max(1, parseInt(String(options.limit), 10))) : 50;
    const offset = options.offset ? Math.max(0, parseInt(String(options.offset), 10)) : 0;

    const dataQuery = `
      SELECT * FROM api_keys
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    values.push(limit, offset);

    const dataRes = await this.pool.query(dataQuery, values);
    const keys = dataRes.rows.map(r => this.mapRowToRecord(r));

    return { keys, total };
  }

  async updateKey(id, updates = {}) {
    await this.init();
    const existing = await this.getKeyById(id);
    if (!existing) return null;

    if (existing.status === 'revoked' && updates.status && updates.status !== 'revoked') {
      throw new Error('Revoked API keys cannot be reactivated.');
    }

    const setClauses = ['updated_at = NOW()'];
    const values = [id];
    let paramIndex = 2;

    if (updates.projectName !== undefined || updates.name !== undefined) {
      const nameVal = updates.name || updates.projectName;
      setClauses.push(`project_name = $${paramIndex}`);
      setClauses.push(`name = $${paramIndex}`);
      values.push(nameVal);
      paramIndex++;
    }
    if (updates.description !== undefined) {
      setClauses.push(`description = $${paramIndex++}`);
      values.push(updates.description);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(updates.status);
      if (updates.status === 'revoked') {
        setClauses.push('revoked_at = NOW()');
      }
    }
    if (updates.expiresAt !== undefined) {
      setClauses.push(`expires_at = $${paramIndex++}`);
      values.push(updates.expiresAt);
    }
    if (updates.rateLimitPerMinute !== undefined || updates.rate_limit_per_minute !== undefined) {
      setClauses.push(`rate_limit_per_minute = $${paramIndex++}`);
      values.push(updates.rateLimitPerMinute || updates.rate_limit_per_minute);
    }

    const query = `
      UPDATE api_keys
      SET ${setClauses.join(', ')}
      WHERE id = $1
      RETURNING *
    `;

    const res = await this.pool.query(query, values);
    if (res.rows.length === 0) return null;
    return this.mapRowToRecord(res.rows[0]);
  }

  async deleteKey(id) {
    await this.init();
    const res = await this.pool.query('DELETE FROM api_keys WHERE id = $1', [id]);
    return (res.rowCount || 0) > 0;
  }

  async recordUsage(keyId, isSuccess = true) {
    await this.init();
    const updateKeyQuery = `
      UPDATE api_keys
      SET total_requests = total_requests + 1,
          successful_requests = successful_requests + $2,
          failed_requests = failed_requests + $3,
          last_used_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `;
    const insertUsageQuery = `
      INSERT INTO api_key_usage (id, key_id, endpoint, status_code, response_time_ms, ip_address, timestamp)
      VALUES ($1, $2, '/api/lookup', $3, 0, 'serverless', NOW())
    `;

    try {
      await Promise.all([
        this.pool.query(updateKeyQuery, [keyId, isSuccess ? 1 : 0, isSuccess ? 0 : 1]),
        this.pool.query(insertUsageQuery, [crypto.randomUUID(), keyId, isSuccess ? 200 : 400]),
      ]);
    } catch (err) {
      console.error('[PostgreSQL] Failed to record API key usage:', err.message);
    }
  }

  async getDashboardStats() {
    await this.init();
    const statsQuery = `
      SELECT
        COUNT(*) as total_keys,
        COUNT(*) FILTER (WHERE status = 'active' AND (expires_at IS NULL OR expires_at > NOW())) as active_keys,
        COUNT(*) FILTER (WHERE status = 'revoked') as revoked_keys,
        COUNT(*) FILTER (WHERE status = 'disabled') as disabled_keys,
        COUNT(*) FILTER (WHERE status != 'revoked' AND expires_at IS NOT NULL AND expires_at <= NOW()) as expired_keys,
        COALESCE(SUM(total_requests), 0) as total_requests,
        COALESCE(SUM(successful_requests), 0) as successful_requests,
        COALESCE(SUM(failed_requests), 0) as failed_requests
      FROM api_keys
    `;

    const res = await this.pool.query(statsQuery);
    const row = res.rows[0];

    return {
      totalKeys: parseInt(row?.total_keys || '0', 10),
      activeKeys: parseInt(row?.active_keys || '0', 10),
      revokedKeys: parseInt(row?.revoked_keys || '0', 10),
      disabledKeys: parseInt(row?.disabled_keys || '0', 10),
      expiredKeys: parseInt(row?.expired_keys || '0', 10),
      totalRequests: parseInt(row?.total_requests || '0', 10),
      successfulRequests: parseInt(row?.successful_requests || '0', 10),
      failedRequests: parseInt(row?.failed_requests || '0', 10),
    };
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

// In-Memory Repository for local test environments without PostgreSQL
class MemoryAdminRepository {
  constructor() {
    this.keys = new Map();
    this.usage = new Map();
    this.adminUsers = new Map();

    const defaultUser = process.env.ADMIN_USERNAME || 'inexpert_trifler';
    const defaultPass = process.env.ADMIN_PASSWORD || 'om sai 0987654321';
    
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(defaultPass, salt, 100000, 64, 'sha512').toString('hex');
    this.adminUsers.set(defaultUser.toLowerCase(), {
      username: defaultUser,
      passwordHash: `pbkdf2:sha512:100000:${salt}:${hash}`,
    });
  }

  async init() {
    // In-memory does not require async schema initialization
  }

  async getAdminUser(username) {
    if (!username) return null;
    const user = this.adminUsers.get(username.trim().toLowerCase());
    return user ? { ...user } : null;
  }

  async hasAnyAdminUser() {
    return this.adminUsers.size > 0;
  }

  async saveAdminUser(username, passwordHash) {
    this.adminUsers.set(username.trim().toLowerCase(), {
      username: username.trim(),
      passwordHash,
    });
  }

  async updateAdminCredentials(oldUsername, newUsername, newPasswordHash) {
    const existing = await this.getAdminUser(oldUsername);
    if (!existing) {
      throw new Error('Admin user not found.');
    }
    this.adminUsers.delete(oldUsername.trim().toLowerCase());
    this.adminUsers.set(newUsername.trim().toLowerCase(), {
      username: newUsername.trim(),
      passwordHash: newPasswordHash || existing.passwordHash,
    });
  }

  async createKey(record) {
    this.keys.set(record.id, { ...record });
  }

  async getKeyById(id) {
    const record = this.keys.get(id);
    return record ? { ...record } : null;
  }

  async getKeyByHash(hash) {
    for (const record of this.keys.values()) {
      if (record.keyHash === hash) {
        return { ...record };
      }
    }
    return null;
  }

  async listKeys(options = {}) {
    let all = Array.from(this.keys.values());

    if (options.search) {
      const q = options.search.toLowerCase();
      all = all.filter(k =>
        (k.projectName && k.projectName.toLowerCase().includes(q)) ||
        (k.name && k.name.toLowerCase().includes(q)) ||
        (k.keyPrefix && k.keyPrefix.toLowerCase().includes(q)) ||
        (k.id && k.id.toLowerCase().includes(q))
      );
    }

    if (options.status && options.status !== 'all') {
      all = all.filter(k => k.status === options.status);
    }

    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = all.length;
    const offset = Number(options.offset) || 0;
    const limit = Number(options.limit) || 50;
    const paginated = all.slice(offset, offset + limit);

    return { keys: paginated, total };
  }

  async updateKey(id, updates = {}) {
    const existing = this.keys.get(id);
    if (!existing) return null;

    if (existing.status === 'revoked' && updates.status && updates.status !== 'revoked') {
      throw new Error('Revoked API keys cannot be reactivated.');
    }

    const updated = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    if (updates.status === 'revoked' && !existing.revokedAt) {
      updated.revokedAt = new Date().toISOString();
    }

    this.keys.set(id, updated);
    return { ...updated };
  }

  async deleteKey(id) {
    const deleted = this.keys.delete(id);
    this.usage.delete(id);
    return deleted;
  }

  async recordUsage(keyId, isSuccess = true) {
    const key = this.keys.get(keyId);
    if (key) {
      key.totalRequests = (key.totalRequests || 0) + 1;
      if (isSuccess) {
        key.successfulRequests = (key.successfulRequests || 0) + 1;
      } else {
        key.failedRequests = (key.failedRequests || 0) + 1;
      }
      key.lastUsedAt = new Date().toISOString();
      key.updatedAt = new Date().toISOString();
      this.keys.set(keyId, key);
    }
  }

  async getDashboardStats() {
    const all = Array.from(this.keys.values());
    const now = new Date();

    let totalKeys = all.length;
    let activeKeys = 0;
    let revokedKeys = 0;
    let disabledKeys = 0;
    let expiredKeys = 0;
    let totalRequests = 0;
    let successfulRequests = 0;
    let failedRequests = 0;

    for (const k of all) {
      if (k.status === 'revoked') {
        revokedKeys++;
      } else if (k.expiresAt && new Date(k.expiresAt) < now) {
        expiredKeys++;
      } else if (k.status === 'disabled') {
        disabledKeys++;
      } else if (k.status === 'active') {
        activeKeys++;
      }

      totalRequests += Number(k.totalRequests || 0);
      successfulRequests += Number(k.successfulRequests || 0);
      failedRequests += Number(k.failedRequests || 0);
    }

    return {
      totalKeys,
      activeKeys,
      revokedKeys,
      disabledKeys,
      expiredKeys,
      totalRequests,
      successfulRequests,
      failedRequests,
    };
  }

  async close() {
    this.keys.clear();
    this.usage.clear();
  }
}

let repositoryInstance = null;

function getAdminRepository() {
  if (!repositoryInstance) {
    const dbUrl = getDatabaseUrl();
    if (dbUrl) {
      repositoryInstance = new PostgresAdminRepository(dbUrl);
    } else {
      repositoryInstance = new MemoryAdminRepository();
    }
  }
  return repositoryInstance;
}

function setAdminRepository(repo) {
  repositoryInstance = repo;
}

module.exports = {
  getAdminRepository,
  setAdminRepository,
  getDatabaseUrl,
  PostgresAdminRepository,
  MemoryAdminRepository,
};
