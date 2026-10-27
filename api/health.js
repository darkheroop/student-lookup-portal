/**
 * Health and Configuration Diagnostic Endpoint (GET /api/health)
 * Reports service status and safe configuration flags without exposing secret values.
 */

module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  const main1Configured = Boolean(process.env.MAIN1_API_KEY?.trim());
  const main2Configured = Boolean(process.env.MAIN2_API_KEY?.trim());

  const responsePayload = {
    status: (main1Configured && main2Configured) ? 'healthy' : 'misconfigured',
    service: 'lookup-service',
    configured: {
      MAIN1_API_KEY: main1Configured,
      MAIN2_API_KEY: main2Configured,
    },
  };

  const statusCode = (main1Configured && main2Configured) ? 200 : 503;

  if (typeof res.status === 'function') {
    return res.status(statusCode).json(responsePayload);
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  return res.end(JSON.stringify(responsePayload));
};
