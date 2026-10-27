/**
 * In-memory rate limiter middleware.
 * Limits client requests per time window based on IP address.
 */

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 30; // Max 30 lookups per minute per IP

const requestHistory = new Map();

function cleanOldEntries(timestamps, now) {
  const cutoff = now - WINDOW_MS;
  return timestamps.filter(ts => ts > cutoff);
}

function rateLimiter(req, res, next) {
  const clientIp = (
    req.headers['x-forwarded-for'] ||
    req.socket.remoteAddress ||
    '127.0.0.1'
  ).toString().split(',')[0].trim();

  const now = Date.now();
  let timestamps = requestHistory.get(clientIp) || [];
  timestamps = cleanOldEntries(timestamps, now);

  if (timestamps.length >= MAX_REQUESTS) {
    return res.status(429).json({
      success: false,
      error: 'Too many requests. Please wait a minute and try again.',
    });
  }

  timestamps.push(now);
  requestHistory.set(clientIp, timestamps);

  // Periodically clean up stale map keys if large
  if (requestHistory.size > 1000) {
    for (const [ip, tsList] of requestHistory.entries()) {
      const active = cleanOldEntries(tsList, now);
      if (active.length === 0) {
        requestHistory.delete(ip);
      } else {
        requestHistory.set(ip, active);
      }
    }
  }

  next();
}

// Reset helper for testing
function _resetRateLimiter() {
  requestHistory.clear();
}

module.exports = {
  rateLimiter,
  _resetRateLimiter,
};
