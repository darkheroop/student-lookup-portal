-- Schema Definition for Neon PostgreSQL Database
-- Student Lookup Portal: Admin Panel & API Key Management

-- 1. Core api_keys table
CREATE TABLE IF NOT EXISTS api_keys (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255),
  project_name VARCHAR(255) NOT NULL,
  description TEXT,
  key_prefix VARCHAR(255) NOT NULL,
  full_key VARCHAR(255),
  api_key VARCHAR(255),
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

-- Non-destructive column additions in case table was created with an older schema
ALTER TABLE api_keys ALTER COLUMN key_prefix TYPE VARCHAR(255);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS name VARCHAR(255);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS full_key VARCHAR(255);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS api_key VARCHAR(255);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL;

-- 2. api_key_usage audit log table
CREATE TABLE IF NOT EXISTS api_key_usage (
  id VARCHAR(64) PRIMARY KEY,
  key_id VARCHAR(64) NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  endpoint VARCHAR(255) NOT NULL,
  status_code INTEGER NOT NULL,
  response_time_ms INTEGER NOT NULL,
  ip_address VARCHAR(64),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. admin_users credentials table
CREATE TABLE IF NOT EXISTS admin_users (
  username VARCHAR(100) PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexes for high performance lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage(key_id);
CREATE INDEX IF NOT EXISTS idx_api_key_usage_timestamp ON api_key_usage(timestamp DESC);
