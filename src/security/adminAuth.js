const crypto = require('crypto');
const { getAdminRepository } = require('../database/adminRepository');

const PBKDF2_ITERATIONS = 100000;
const PBKDF2_KEYLEN = 64;
const PBKDF2_DIGEST = 'sha512';
const PREFIX = 'pbkdf2:sha512:100000:';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSessionSecret() {
  return process.env.ADMIN_SESSION_SECRET || 'student-lookup-portal-secret-key-32chars';
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
    .toString('hex');
  return `${PREFIX}${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash) {
    return false;
  }

  if (storedHash.startsWith(PREFIX)) {
    const parts = storedHash.slice(PREFIX.length).split(':');
    if (parts.length !== 2) {
      return false;
    }
    const [salt, expectedHash] = parts;
    const computedHash = crypto
      .pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST)
      .toString('hex');

    const expectedBuf = Buffer.from(expectedHash, 'hex');
    const computedBuf = Buffer.from(computedHash, 'hex');
    if (expectedBuf.length !== computedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, computedBuf);
  }

  // Constant-time fallback for initial bootstrap comparison
  const userPassBuf = Buffer.from(password.trim());
  const expectedPassBuf = Buffer.from(storedHash.trim());
  if (userPassBuf.length !== expectedPassBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(userPassBuf, expectedPassBuf);
}

class AdminAuth {
  static async validateCredentials(username, password) {
    if (!username || !password) {
      return false;
    }

    try {
      const repo = getAdminRepository();
      const adminUser = await repo.getAdminUser(username);

      if (adminUser) {
        return verifyPassword(password, adminUser.passwordHash);
      }

      // Bootstrap fallback only if no admin user is registered in the repository yet
      const hasAnyAdmin = (typeof repo.hasAnyAdminUser === 'function') ? await repo.hasAnyAdminUser() : false;
      if (!hasAnyAdmin) {
        const bootstrapUser = process.env.ADMIN_USERNAME || 'inexpert_trifler';
        const bootstrapPass = process.env.ADMIN_PASSWORD || 'om sai 0987654321';

        if (username.trim().toLowerCase() === bootstrapUser.toLowerCase() && password === bootstrapPass) {
          try {
            await repo.saveAdminUser(bootstrapUser, hashPassword(bootstrapPass));
          } catch {
            // ignore
          }
          return true;
        }
      }

      return false;
    } catch (err) {
      return false;
    }
  }

  static async updateCredentials(currentUsername, currentPassword, newUsername, newPassword) {
    const isValid = await this.validateCredentials(currentUsername, currentPassword);
    if (!isValid) {
      return { success: false, message: 'Current password is incorrect.', error: 'Current password is incorrect.' };
    }

    const targetUsername = (newUsername && newUsername.trim()) ? newUsername.trim() : currentUsername;
    let targetPasswordHash = undefined;

    if (newPassword && newPassword.trim()) {
      if (newPassword.trim().length < 6) {
        return {
          success: false,
          message: 'New password must be at least 6 characters long.',
          error: 'New password must be at least 6 characters long.',
        };
      }
      targetPasswordHash = hashPassword(newPassword.trim());
    }

    const repo = getAdminRepository();
    await repo.updateAdminCredentials(currentUsername, targetUsername, targetPasswordHash);

    return {
      success: true,
      message: 'Account credentials updated successfully.',
      username: targetUsername,
    };
  }

  static createSession(username) {
    const exp = Date.now() + SESSION_TTL_MS;
    const csrf = crypto.randomBytes(24).toString('hex');
    const payload = { username, exp, csrf };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payloadStr)
      .digest('hex');

    const token = `${payloadStr}.${signature}`;
    return {
      token,
      csrfToken: csrf,
      expiresAt: new Date(exp).toISOString(),
    };
  }

  static verifySession(token) {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'MISSING_TOKEN' };
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, error: 'MALFORMED_TOKEN' };
    }

    const [payloadStr, signature] = parts;
    const expectedSig = crypto
      .createHmac('sha256', getSessionSecret())
      .update(payloadStr)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expSigBuf = Buffer.from(expectedSig);

    if (sigBuf.length !== expSigBuf.length || !crypto.timingSafeEqual(sigBuf, expSigBuf)) {
      return { valid: false, error: 'INVALID_SIGNATURE' };
    }

    try {
      const decoded = JSON.parse(Buffer.from(payloadStr, 'base64url').toString('utf-8'));
      if (Date.now() > decoded.exp) {
        return { valid: false, error: 'EXPIRED_SESSION' };
      }

      return {
        valid: true,
        username: decoded.username,
        csrfToken: decoded.csrf,
      };
    } catch {
      return { valid: false, error: 'CORRUPTED_PAYLOAD' };
    }
  }

  static setSessionCookies(res, token, csrfToken) {
    const isProd = process.env.NODE_ENV === 'production';

    res.cookie('admin_session', token, {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    res.cookie('admin_csrf', csrfToken, {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  static clearSessionCookies(res) {
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie('admin_session', {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    });
    res.clearCookie('admin_csrf', {
      httpOnly: false,
      secure: isProd,
      sameSite: 'lax',
      path: '/',
    });
  }
}

module.exports = {
  AdminAuth,
  hashPassword,
  verifyPassword,
};
