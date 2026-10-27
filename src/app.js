const express = require('express');
const path = require('path');
const lookupHandler = require('../api/lookup');
const adminRoutes = require('./routes/adminRoutes');
const { rateLimiter } = require('./middleware/rateLimiter');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';"
  );
  next();
});

// Cookie parsing middleware
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const pairs = cookieHeader.split(';');
    for (const pair of pairs) {
      const idx = pair.indexOf('=');
      if (idx !== -1) {
        const key = pair.substring(0, idx).trim();
        const val = pair.substring(idx + 1).trim();
        try {
          req.cookies[key] = decodeURIComponent(val);
        } catch {
          req.cookies[key] = val;
        }
      }
    }
  }
  next();
});

// JSON body parser with strict size limit
app.use(express.json({ limit: '10kb' }));

// Static frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ status: 'ok', service: 'lookup-service' });
});

// Mount Admin API routes
app.use(['/api/admin', '/admin/api'], adminRoutes);

// Direct admin login and logout endpoints
app.post(['/admin/login', '/admin/logout'], (req, res, next) => {
  req.url = req.url.replace(/^\/admin/, '');
  adminRoutes(req, res, next);
});

// Admin UI routes
app.get(['/admin', '/admin/dashboard', '/admin/*'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Mount /api/lookup and /lookup
app.all(['/api/lookup', '/lookup'], rateLimiter, (req, res) => {
  return lookupHandler(req, res);
});

// Fallback error handler
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid 10-digit number.',
    });
  }

  return res.status(500).json({
    success: false,
    error: 'The lookup service is temporarily unavailable. Please try again.',
  });
});

module.exports = app;
