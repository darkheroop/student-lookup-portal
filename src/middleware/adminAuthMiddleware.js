const { AdminAuth } = require('../security/adminAuth');

function requireAdminAuth(req, res, next) {
  // Extract token from Authorization Bearer or Cookie
  const authHeader = req.headers['authorization'];
  let bearerToken = null;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const cookieToken = req.cookies?.admin_session;
  const token = bearerToken || cookieToken;

  if (!token) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Administrator authentication required. Please log in.',
      },
    });
  }

  const verification = AdminAuth.verifySession(token);
  if (!verification.valid || !verification.username) {
    if (cookieToken) {
      AdminAuth.clearSessionCookies(res);
    }
    return res.status(401).json({
      success: false,
      error: {
        code: 'SESSION_EXPIRED',
        message: 'Your administrator session has expired or is invalid. Please log in again.',
      },
    });
  }

  // CSRF Protection: For mutating requests authenticated via cookies (not Bearer header)
  const isMutating = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method.toUpperCase());
  const isCookieAuth = !bearerToken && Boolean(cookieToken);

  if (isMutating && isCookieAuth) {
    const csrfHeader = req.headers['x-csrf-token'];
    if (!csrfHeader || csrfHeader !== verification.csrfToken) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'CSRF_MISMATCH',
          message: 'Cross-Site Request Forgery (CSRF) validation failed. Please refresh the page and try again.',
        },
      });
    }
  }

  req.adminUser = { username: verification.username };
  next();
}

module.exports = {
  requireAdminAuth,
};
