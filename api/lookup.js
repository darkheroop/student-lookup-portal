/**
 * Vercel Serverless Function for POST /api/lookup
 * Connects frontend request to Main1 -> Main2 sequential integration.
 */

const { orchestrateLookup } = require('../lib/apiClients');

/**
 * Helper to ensure the request body is parsed as JSON across
 * Vercel Serverless, Express, and raw Node.js HTTP environments.
 * @param {import('http').IncomingMessage & { body?: any }} req
 * @returns {Promise<any>}
 */
async function getParsedBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }

  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new Error('INVALID_JSON');
    }
  }

  // If body is not yet parsed, read the stream
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10 * 1024) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', err => reject(err));
  });
}

/**
 * Serverless Function Handler
 * @param {import('http').IncomingMessage & { body?: any }} req
 * @param {import('http').ServerResponse & { status?: Function, json?: Function }} res
 */
module.exports = async function handler(req, res) {
  // Security and Cache Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');

  // Enforce POST method
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    const responsePayload = {
      success: false,
      error: 'Method not allowed. Use POST.',
    };
    if (typeof res.status === 'function') {
      return res.status(405).json(responsePayload);
    }
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(responsePayload));
  }

  let body;
  try {
    body = await getParsedBody(req);
  } catch (parseErr) {
    const errorMsg = parseErr.message === 'PAYLOAD_TOO_LARGE'
      ? 'Request payload too large.'
      : 'Please enter a valid 10-digit number.';
    const status = parseErr.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400;

    if (typeof res.status === 'function') {
      return res.status(status).json({ success: false, error: errorMsg });
    }
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: errorMsg }));
  }

  try {
    const studentNumber = body?.studentNumber;
    const result = await orchestrateLookup(studentNumber, process.env);

    if (typeof res.status === 'function') {
      return res.status(200).json(result);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(result));
  } catch (err) {
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const safeError = err.message || 'The lookup service is temporarily unavailable. Please try again.';

    if (typeof res.status === 'function') {
      return res.status(statusCode).json({ success: false, error: safeError });
    }
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ success: false, error: safeError }));
  }
};
