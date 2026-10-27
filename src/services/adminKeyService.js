const crypto = require('crypto');
const { getAdminRepository } = require('../database/adminRepository');

class AdminKeyService {
  hashKey(rawKey) {
    return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
  }

  async createKey(input = {}) {
    const projectName = (input.name || input.projectName || '').trim();
    if (!projectName || projectName.length < 2) {
      throw new Error('Project or application name must be at least 2 characters long.');
    }

    const rawSecret = crypto.randomBytes(32).toString('hex');
    const fullKey = `sk_support_${rawSecret}`;
    const keyHash = this.hashKey(fullKey);

    const now = new Date().toISOString();
    let expiresAt = null;
    if (input.expiresAt) {
      const parsedDate = new Date(input.expiresAt);
      if (isNaN(parsedDate.getTime())) {
        throw new Error('Invalid expiration date format.');
      }
      if (parsedDate <= new Date()) {
        throw new Error('Expiration date must be in the future.');
      }
      expiresAt = parsedDate.toISOString();
    }

    const rateLimit = input.rate_limit_per_minute || input.rateLimitPerMinute || 60;

    const record = {
      id: crypto.randomUUID(),
      projectName,
      name: projectName,
      fullKey,
      apiKey: fullKey,
      keyPrefix: fullKey,
      keyHash,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      expiresAt,
      lastUsedAt: null,
      rateLimitPerMinute: Number(rateLimit) || 60,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
    };

    const repo = getAdminRepository();
    await repo.createKey(record);

    return {
      key: fullKey,
      record: {
        id: record.id,
        name: record.projectName,
        projectName: record.projectName,
        api_key: fullKey,
        apiKey: fullKey,
        full_key: fullKey,
        fullKey,
        keyPrefix: fullKey,
        is_active: true,
        status: record.status,
        rate_limit_per_minute: record.rateLimitPerMinute,
        requests_count: 0,
        totalRequests: 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
        last_used_at: null,
      },
    };
  }

  async listKeys(options = {}) {
    const repo = getAdminRepository();
    const result = await repo.listKeys(options);

    const mappedKeys = result.keys.map(k => {
      const fullKey = k.fullKey || k.apiKey || k.api_key || k.keyPrefix;
      return {
        id: k.id,
        name: k.projectName || k.name,
        projectName: k.projectName || k.name,
        api_key: fullKey,
        apiKey: fullKey,
        full_key: fullKey,
        fullKey,
        keyPrefix: fullKey,
        is_active: k.status === 'active',
        status: k.status,
        rate_limit_per_minute: k.rateLimitPerMinute || 60,
        requests_count: k.totalRequests || 0,
        totalRequests: k.totalRequests || 0,
        createdAt: k.createdAt,
        updatedAt: k.updatedAt,
        expiresAt: k.expiresAt,
        last_used_at: k.lastUsedAt,
      };
    });

    return {
      keys: mappedKeys,
      total: result.total,
    };
  }

  async getKeyById(id) {
    const repo = getAdminRepository();
    const k = await repo.getKeyById(id);
    if (!k) return null;
    const fullKey = k.fullKey || k.apiKey || k.api_key || k.keyPrefix;
    return {
      id: k.id,
      name: k.projectName || k.name,
      projectName: k.projectName || k.name,
      api_key: fullKey,
      apiKey: fullKey,
      full_key: fullKey,
      fullKey,
      keyPrefix: fullKey,
      is_active: k.status === 'active',
      status: k.status,
      rate_limit_per_minute: k.rateLimitPerMinute || 60,
      requests_count: k.totalRequests || 0,
      totalRequests: k.totalRequests || 0,
      createdAt: k.createdAt,
      updatedAt: k.updatedAt,
      expiresAt: k.expiresAt,
      last_used_at: k.lastUsedAt,
    };
  }

  async updateKey(id, updates = {}) {
    const repo = getAdminRepository();
    return repo.updateKey(id, updates);
  }

  async deleteKey(id) {
    const repo = getAdminRepository();
    return repo.deleteKey(id);
  }

  async getDashboardMetrics() {
    const repo = getAdminRepository();
    return repo.getDashboardStats();
  }

  async validateClientApiKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return null;
    const hash = this.hashKey(rawKey);
    const repo = getAdminRepository();
    const record = await repo.getKeyByHash(hash);
    if (!record) return null;
    if (record.status !== 'active') return null;
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) return null;
    return record;
  }
}

const adminKeyService = new AdminKeyService();

module.exports = {
  adminKeyService,
  AdminKeyService,
};
