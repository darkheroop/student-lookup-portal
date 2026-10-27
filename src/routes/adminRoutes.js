const express = require('express');
const { AdminAuth } = require('../security/adminAuth');
const { requireAdminAuth } = require('../middleware/adminAuthMiddleware');
const { adminKeyService } = require('../services/adminKeyService');

const router = express.Router();

// In-memory rate limiting for admin login (10 attempts per 15m)
const loginAttempts = new Map();
function adminLoginRateLimiter(req, res, next) {
  if (process.env.NODE_ENV === 'test') {
    return next();
  }
  const clientIp = (
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '127.0.0.1'
  ).toString().split(',')[0].trim();

  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  let timestamps = loginAttempts.get(clientIp) || [];
  timestamps = timestamps.filter(ts => ts > now - windowMs);

  if (timestamps.length >= 10) {
    return res.status(429).json({
      success: false,
      error: {
        code: 'TOO_MANY_LOGIN_ATTEMPTS',
        message: 'Too many login attempts from this IP address. Please wait 15 minutes before trying again.',
      },
    });
  }

  timestamps.push(now);
  loginAttempts.set(clientIp, timestamps);
  next();
}

/**
 * POST /login and /api/login
 * Authenticates administrator and sets secure HTTP-only cookie + returns session token & CSRF token.
 */
router.post(['/login', '/api/login'], adminLoginRateLimiter, async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'Username and password are required.',
      },
    });
  }

  const isValid = await AdminAuth.validateCredentials(username, password);

  if (!isValid) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid administrator username or password.',
      },
    });
  }

  const session = AdminAuth.createSession(username);
  AdminAuth.setSessionCookies(res, session.token, session.csrfToken);

  return res.json({
    success: true,
    message: 'Authenticated successfully.',
    token: session.token,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
    user: { username },
  });
});

/**
 * POST /logout and /api/logout
 */
router.post(['/logout', '/api/logout'], (req, res) => {
  AdminAuth.clearSessionCookies(res);
  return res.json({
    success: true,
    message: 'Logged out successfully.',
  });
});

/**
 * GET /logout
 */
router.get('/logout', (req, res) => {
  AdminAuth.clearSessionCookies(res);
  return res.redirect('/admin');
});

/**
 * GET /session and /api/session
 * Verifies active session.
 */
router.get(['/session', '/api/session'], (req, res) => {
  const authHeader = req.headers['authorization'];
  let token = null;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.cookies?.admin_session) {
    token = req.cookies.admin_session;
  }

  if (!token) {
    return res.json({ authenticated: false });
  }

  const verification = AdminAuth.verifySession(token);
  if (!verification.valid || !verification.username) {
    AdminAuth.clearSessionCookies(res);
    return res.json({ authenticated: false });
  }

  return res.json({
    authenticated: true,
    user: { username: verification.username, role: 'main_admin' },
    csrfToken: verification.csrfToken,
  });
});

// All routes below require administrator authentication
router.use(requireAdminAuth);

/**
 * POST /account/update and /api/account/update
 */
router.post(['/account/update', '/api/account/update'], async (req, res) => {
  try {
    const currentUsername = req.adminUser?.username || process.env.ADMIN_USERNAME || 'inexpert_trifler';
    const currentPassword = req.body?.current_password || req.body?.currentPassword;
    const newUsername = req.body?.new_username || req.body?.newUsername;
    const newPassword = req.body?.new_password || req.body?.newPassword;

    if (!currentPassword) {
      return res.status(400).json({
        success: false,
        error: 'Current password is required to save account changes.',
      });
    }

    const updateResult = await AdminAuth.updateCredentials(
      currentUsername,
      currentPassword,
      newUsername,
      newPassword
    );

    if (!updateResult.success) {
      return res.status(400).json({
        success: false,
        error: updateResult.message,
      });
    }

    const effectiveUsername = updateResult.username || currentUsername;
    const session = AdminAuth.createSession(effectiveUsername);
    AdminAuth.setSessionCookies(res, session.token, session.csrfToken);

    return res.json({
      success: true,
      message: updateResult.message,
      username: effectiveUsername,
      csrfToken: session.csrfToken,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /dashboard and /api/dashboard
 */
router.get(['/dashboard', '/api/dashboard'], async (_req, res) => {
  try {
    const stats = await adminKeyService.getDashboardMetrics();
    return res.json({
      success: true,
      stats,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /keys, /client-keys, /api/client-keys
 */
router.get(['/keys', '/client-keys', '/api/client-keys'], async (req, res) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const limit = req.query.limit ? Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10))) : 50;
    const offset = req.query.offset ? Math.max(0, parseInt(String(req.query.offset), 10)) : 0;

    const result = await adminKeyService.listKeys({ search, status, limit, offset });

    return res.json({
      success: true,
      keys: result.keys,
      total: result.total,
      limit,
      offset,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /keys, /client-keys, /api/client-keys
 */
router.post(['/keys', '/client-keys', '/api/client-keys'], async (req, res) => {
  try {
    const name = req.body?.name || req.body?.projectName;
    const rateLimit = req.body?.rate_limit_per_minute !== undefined ? req.body.rate_limit_per_minute : req.body?.rateLimitPerMinute;
    const expiresAt = req.body?.expiresAt || null;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Project or application name must be at least 2 characters long.',
        },
      });
    }

    const { key, record } = await adminKeyService.createKey({
      projectName: name.trim(),
      expiresAt: typeof expiresAt === 'string' ? expiresAt : undefined,
      rateLimitPerMinute: rateLimit ? Number(rateLimit) : 60,
    });

    return res.status(201).json({
      success: true,
      message: 'API key generated successfully. Copy the secret now; it will never be displayed again.',
      key, // Plaintext secret returned ONCE
      record,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /keys/:id
 */
router.get('/keys/:id', async (req, res) => {
  try {
    const record = await adminKeyService.getKeyById(req.params.id);
    if (!record) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'API key not found.' },
      });
    }
    return res.json({
      success: true,
      key: record,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /keys/:id
 */
router.patch('/keys/:id', async (req, res) => {
  try {
    const updated = await adminKeyService.updateKey(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'API key not found.' },
      });
    }
    return res.json({
      success: true,
      message: 'API key updated successfully.',
      key: updated,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /keys/:id/toggle, /client-keys/:id/toggle, /api/client-keys/:id/toggle
 */
router.post(['/keys/:id/toggle', '/client-keys/:id/toggle', '/api/client-keys/:id/toggle'], async (req, res) => {
  try {
    const key = await adminKeyService.getKeyById(req.params.id);
    if (!key) {
      return res.status(404).json({ success: false, error: 'API key not found.' });
    }

    const newStatus = key.status === 'active' ? 'disabled' : 'active';
    const updated = await adminKeyService.updateKey(req.params.id, { status: newStatus });

    return res.json({
      success: true,
      message: `API key ${newStatus === 'active' ? 'activated' : 'revoked'} successfully.`,
      key: updated,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /keys/:id/revoke
 */
router.post('/keys/:id/revoke', async (req, res) => {
  try {
    const updated = await adminKeyService.updateKey(req.params.id, { status: 'revoked' });
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'API key not found.' },
      });
    }
    return res.json({
      success: true,
      message: 'API key permanently revoked.',
      key: updated,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /keys/:id, /client-keys/:id, /api/client-keys/:id
 */
router.delete(['/keys/:id', '/client-keys/:id', '/api/client-keys/:id'], async (req, res) => {
  try {
    const deleted = await adminKeyService.deleteKey(req.params.id);
    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'API key not found.',
      });
    }
    return res.json({
      success: true,
      message: 'API key deleted successfully.',
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
