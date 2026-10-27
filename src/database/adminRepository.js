const crypto = require('crypto');

class MemoryAdminRepository {
  constructor() {
    this.keys = new Map();
    this.usage = new Map();
    this.adminUsers = new Map();

    const defaultUser = process.env.ADMIN_USERNAME || 'inexpert_trifler';
    const defaultPass = process.env.ADMIN_PASSWORD || 'om sai 0987654321';
    
    // Lazy hash on initialization
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(defaultPass, salt, 100000, 64, 'sha512').toString('hex');
    this.adminUsers.set(defaultUser.toLowerCase(), {
      username: defaultUser,
      passwordHash: `pbkdf2:sha512:100000:${salt}:${hash}`,
    });
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

    // Sort descending by createdAt
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
}

let repositoryInstance = null;

function getAdminRepository() {
  if (!repositoryInstance) {
    repositoryInstance = new MemoryAdminRepository();
  }
  return repositoryInstance;
}

module.exports = {
  getAdminRepository,
  MemoryAdminRepository,
};
