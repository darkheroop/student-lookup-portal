/**
 * Health and Configuration Diagnostic Endpoint (GET /api/health)
 * Reports service status and safe configuration flags without exposing secret values.
 */

const { validateConfig } = require('../lib/apiClients');

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  let isConfigured = false;
  try {
    const { main1Key, main2Key } = validateConfig(process.env);
    isConfigured = Boolean(main1Key && main2Key);
  } catch {
    isConfigured = false;
  }

  const responsePayload = {
    status: isConfigured ? 'healthy' : 'misconfigured',
    service: 'lookup-service',
    configured: {
      MAIN1_API_KEY: isConfigured,
      MAIN2_API_KEY: isConfigured,
    },
  };

  const statusCode = isConfigured ? 200 : 503;

  if (typeof res.status === 'function') {
    return res.status(statusCode).json(responsePayload);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(responsePayload));
};
