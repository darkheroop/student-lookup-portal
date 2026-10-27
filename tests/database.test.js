const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  getDatabaseUrl,
  getAdminRepository,
  setAdminRepository,
  MemoryAdminRepository,
  PostgresAdminRepository,
} = require('../src/database/adminRepository');
const { runMigrations } = require('../src/database/migrate');

test('Database Config: getDatabaseUrl recognizes Neon environment variables', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_POSTGRES_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.POSTGRES_URL;
    assert.strictEqual(getDatabaseUrl(), undefined);

    process.env.DATABASE_POSTGRES_URL = 'postgres://testuser:testpass@ep-pooler.neon.tech/neondb';
    assert.strictEqual(getDatabaseUrl(), 'postgres://testuser:testpass@ep-pooler.neon.tech/neondb');

    // DATABASE_URL takes priority when set
    process.env.DATABASE_URL = 'postgres://priority:secret@ep-main.neon.tech/neondb';
    assert.strictEqual(getDatabaseUrl(), 'postgres://priority:secret@ep-main.neon.tech/neondb');
  } finally {
    process.env = origEnv;
  }
});

test('Database Schema: schema.sql contains required tables and indexes', () => {
  const schemaPath = path.join(__dirname, '../src/database/schema.sql');
  assert.ok(fs.existsSync(schemaPath), 'schema.sql must exist');

  const content = fs.readFileSync(schemaPath, 'utf-8');
  assert.ok(content.includes('CREATE TABLE IF NOT EXISTS api_keys'), 'Must define api_keys');
  assert.ok(content.includes('CREATE TABLE IF NOT EXISTS api_key_usage'), 'Must define api_key_usage');
  assert.ok(content.includes('CREATE TABLE IF NOT EXISTS admin_users'), 'Must define admin_users');
  assert.ok(content.includes('CREATE INDEX IF NOT EXISTS idx_api_keys_hash'), 'Must index key_hash');
  assert.ok(content.includes('CREATE INDEX IF NOT EXISTS idx_api_keys_status'), 'Must index status');
});

test('Database Migrations: runMigrations handles missing DATABASE_URL gracefully without crashing', async () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_POSTGRES_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.POSTGRES_URL;

    const res = await runMigrations();
    assert.strictEqual(res.success, false);
    assert.strictEqual(res.skipped, true);
    assert.strictEqual(res.reason, 'NO_DATABASE_URL');
  } finally {
    process.env = origEnv;
  }
});

test('Database Factory: Returns MemoryAdminRepository in development/test when DATABASE_URL absent', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.DATABASE_URL;
    delete process.env.DATABASE_POSTGRES_URL;
    delete process.env.DATABASE_URL_UNPOOLED;
    delete process.env.POSTGRES_URL;
    setAdminRepository(null);

    const repo = getAdminRepository();
    assert.ok(repo instanceof MemoryAdminRepository);
  } finally {
    process.env = origEnv;
    setAdminRepository(null);
  }
});

test('PostgresAdminRepository: mapRowToRecord correctly maps DB columns to camelCase', () => {
  const repo = new PostgresAdminRepository({ query: async () => {} });
  const mockRow = {
    id: 'key_123',
    name: 'Frontend Client',
    project_name: 'Frontend Client',
    description: 'Test description',
    key_prefix: 'sk_support_abc12345...',
    key_hash: 'hash_abc123',
    status: 'active',
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    expires_at: null,
    revoked_at: null,
    last_used_at: new Date('2026-01-02T12:00:00.000Z'),
    rate_limit_per_minute: 120,
    total_requests: '45',
    successful_requests: '40',
    failed_requests: '5',
  };

  const record = repo.mapRowToRecord(mockRow);
  assert.strictEqual(record.id, 'key_123');
  assert.strictEqual(record.name, 'Frontend Client');
  assert.strictEqual(record.projectName, 'Frontend Client');
  assert.strictEqual(record.keyPrefix, 'sk_support_abc12345...');
  assert.strictEqual(record.rateLimitPerMinute, 120);
  assert.strictEqual(record.totalRequests, 45);
  assert.strictEqual(record.successfulRequests, 40);
  assert.strictEqual(record.failedRequests, 5);
  assert.strictEqual(record.lastUsedAt, '2026-01-02T12:00:00.000Z');
});
