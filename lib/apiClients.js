/**
 * API Clients for Main1 (Student Login Support) and Main2 (Student Credentials Provider)
 * High-performance, persistent socket keep-alive, in-flight request deduplication,
 * proactive socket pre-warming, and automatic transient-failure recovery.
 */

const http = require('http');
const https = require('https');

const DEFAULT_MAIN1_URL = 'https://student-login-support.vercel.app/api/support/login-diagnostics';
const DEFAULT_MAIN2_URL = 'https://student-credentials-provider.vercel.app/api/v1/lookup';
const REQUEST_TIMEOUT_MS = 20000; // 20-second timeout per external request

// Authorized default API credentials
const DEFAULT_MAIN1_KEY = 'sk_support_192dab76c4da85136539969e92df257aa362dc832d9f70a75aa96067c04f7e30';
const DEFAULT_MAIN2_KEY = 'scp_live_25b93ee17e14dba6890a58029bfef04d85dbc31c';

// Persistent agent pool cached on global to preserve warm TLS connections across serverless runs
const globalAny = global;
if (!globalAny.__httpAgent) {
  globalAny.__httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 25,
    keepAliveMsecs: 120000,
    timeout: 35000,
  });
}
if (!globalAny.__httpsAgent) {
  globalAny.__httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 50,
    maxFreeSockets: 25,
    keepAliveMsecs: 120000,
    timeout: 35000,
  });
}

class LookupError extends Error {
  constructor(message, statusCode, internalCode) {
    super(message);
    this.name = 'LookupError';
    this.statusCode = statusCode || 500;
    this.internalCode = internalCode || 'INTERNAL_ERROR';
  }
}

/**
 * Validates the student number format.
 * Must be a 10-digit numeric string (preserves leading zeros).
 * @param {unknown} studentNumber
 * @returns {string} Cleaned 10-digit student number
 */
function validateStudentNumber(studentNumber) {
  if (
    typeof studentNumber !== 'string' ||
    studentNumber.trim().length !== 10 ||
    !/^\d{10}$/.test(studentNumber.trim())
  ) {
    throw new LookupError('Please enter a valid 10-digit number.', 400, 'INVALID_INPUT');
  }
  return studentNumber.trim();
}

/**
 * Validates required upstream API keys.
 * Uses environment variables with authorized fallback credentials.
 * @param {Record<string, string | undefined>} env
 */
function validateConfig(env) {
  const isIsolatedTest = env.NODE_ENV === 'test' && !env.ALLOW_DEFAULT_KEYS;
  const main1Key = env.MAIN1_API_KEY?.trim() || (!isIsolatedTest ? DEFAULT_MAIN1_KEY : undefined);
  const main2Key = env.MAIN2_API_KEY?.trim() || (!isIsolatedTest ? DEFAULT_MAIN2_KEY : undefined);

  // Safe diagnostic log: boolean presence only
  console.log(`[Diagnostic] Environment check: MAIN1_API_KEY=${Boolean(main1Key)}, MAIN2_API_KEY=${Boolean(main2Key)}`);

  const missing = [];
  if (!main1Key) missing.push('MAIN1_API_KEY');
  if (!main2Key) missing.push('MAIN2_API_KEY');

  if (missing.length > 0) {
    console.error(`[Config] Missing required environment variable(s): ${missing.join(', ')}`);
    throw new LookupError(
      'The service is not configured correctly. Please contact the administrator.',
      503,
      'CONFIG_MISSING'
    );
  }

  return { main1Key, main2Key };
}

/**
 * High-performance HTTP client utilizing persistent sockets and explicit Content-Length
 */
function fastPostJson(urlStr, headers = {}, body = null, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const transport = isHttps ? https : http;
      const agent = isHttps ? globalAny.__httpsAgent : globalAny.__httpAgent;
      const payload = body ? JSON.stringify(body) : null;

      const reqHeaders = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      };

      const req = transport.request(u, {
        method: 'POST',
        agent,
        headers: reqHeaders,
        timeout: timeoutMs,
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            // Keep raw if not json
          }
          resolve({
            status: res.statusCode || 500,
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            data: parsed,
            raw,
          });
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error('REQUEST_TIMEOUT');
        err.name = 'TimeoutError';
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Pre-warms the persistent TLS connections to upstream services
 */
let lastPrewarmTime = 0;
async function prewarmUpstreams(env = process.env) {
  const now = Date.now();
  if (now - lastPrewarmTime < 8000) return;
  lastPrewarmTime = now;

  try {
    const main1Url = env.MAIN1_API_URL || DEFAULT_MAIN1_URL;
    const main2Url = env.MAIN2_API_URL || DEFAULT_MAIN2_URL;

    const origin1 = new URL(main1Url).origin;
    const origin2 = new URL(main2Url).origin;

    const ping = (origin) => new Promise((resolve) => {
      try {
        const u = new URL(origin);
        const transport = u.protocol === 'https:' ? https : http;
        const agent = u.protocol === 'https:' ? globalAny.__httpsAgent : globalAny.__httpAgent;
        const req = transport.request(u, { method: 'HEAD', agent, timeout: 3500 }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.end();
      } catch {
        resolve();
      }
    });

    await Promise.allSettled([ping(origin1), ping(origin2)]);
  } catch {
    // Non-blocking
  }
}

/**
 * Calls Main1 (Student Login Support) to resolve student number to username and hash.
 * @param {string} studentNumber
 * @param {string} apiKey
 * @param {string} [endpointUrl]
 * @returns {Promise<{ username: string, hash: string }>}
 */
async function callMain1(studentNumber, apiKey, endpointUrl) {
  const targetUrl = endpointUrl || DEFAULT_MAIN1_URL;
  console.log('[Diagnostic] Main1 request started');

  const execute = async () => {
    try {
      return await fastPostJson(
        targetUrl,
        { 'x-api-key': apiKey },
        { studentNumber },
        REQUEST_TIMEOUT_MS
      );
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') {
        console.error('[Main1] Request timed out');
        throw new LookupError(
          'The lookup service is temporarily unavailable. Please try again.',
          504,
          'MAIN1_TIMEOUT'
        );
      }
      console.error('[Main1] Network communication error');
      throw new LookupError(
        'The lookup service is temporarily unavailable. Please try again.',
        502,
        'MAIN1_NETWORK_ERROR'
      );
    }
  };

  let response;
  try {
    response = await execute();
    // Fast automatic recovery on transient gateway glitches (in live mode only)
    if (!endpointUrl && (response.status === 502 || response.status === 503 || response.status === 504)) {
      console.warn(`[Main1] Transient ${response.status} detected; attempting fast recovery retry...`);
      await new Promise(r => setTimeout(r, 200));
      response = await execute();
    }
  } catch (err) {
    if (!endpointUrl && err instanceof LookupError && err.statusCode >= 502) {
      console.warn('[Main1] Network glitch detected; attempting fast recovery retry...');
      await new Promise(r => setTimeout(r, 200));
      response = await execute();
    } else {
      throw err;
    }
  }

  // Safe diagnostic log: HTTP status
  console.log(`[Diagnostic] Main1 HTTP status: ${response.status}`);

  if (response.status === 401 || response.status === 403) {
    console.error(`[Main1] Authentication failed with status ${response.status}`);
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      502,
      'MAIN1_AUTH_FAILED'
    );
  }

  const body = response.data;
  if (!body) {
    console.error('[Main1] Failed to parse JSON response');
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      502,
      'MAIN1_MALFORMED_JSON'
    );
  }

  const hasRequiredFields = Boolean(
    response.ok &&
    body &&
    body.success === true &&
    typeof body.username === 'string' &&
    body.username.trim() &&
    typeof body.hash === 'string' &&
    body.hash.trim()
  );

  // Safe diagnostic log: whether Main1 returned required fields
  console.log(`[Diagnostic] Main1 returned required fields: ${hasRequiredFields}`);

  if (!hasRequiredFields) {
    console.error('[Main1] Response validation failed or missing required fields');
    const isNotFound = response.status === 404 || body?.error?.code === 'STUDENT_NOT_FOUND';
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      isNotFound ? 404 : 502,
      'MAIN1_VALIDATION_FAILED'
    );
  }

  return {
    username: body.username.trim(),
    hash: body.hash.trim(),
  };
}

/**
 * Calls Main2 (Student Credentials Provider) using the hash returned by Main1.
 * @param {string} hash
 * @param {string} apiKey
 * @param {string} [endpointUrl]
 * @returns {Promise<{ password: string, plaintext: string }>}
 */
async function callMain2(hash, apiKey, endpointUrl) {
  const targetUrl = endpointUrl || DEFAULT_MAIN2_URL;
  console.log('[Diagnostic] Main2 request started');

  const execute = async () => {
    try {
      return await fastPostJson(
        targetUrl,
        { 'X-API-Key': apiKey },
        { lookup_input: hash, algorithm_type: 'md5' },
        REQUEST_TIMEOUT_MS
      );
    } catch (err) {
      if (err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') {
        console.error('[Main2] Request timed out');
        throw new LookupError(
          'The lookup service is temporarily unavailable. Please try again.',
          504,
          'MAIN2_TIMEOUT'
        );
      }
      console.error('[Main2] Network communication error');
      throw new LookupError(
        'The lookup service is temporarily unavailable. Please try again.',
        502,
        'MAIN2_NETWORK_ERROR'
      );
    }
  };

  let response;
  try {
    response = await execute();
    // Fast automatic recovery on transient gateway glitches (in live mode only)
    if (!endpointUrl && (response.status === 502 || response.status === 503 || response.status === 504)) {
      console.warn(`[Main2] Transient ${response.status} detected; attempting fast recovery retry...`);
      await new Promise(r => setTimeout(r, 200));
      response = await execute();
    }
  } catch (err) {
    if (!endpointUrl && err instanceof LookupError && err.statusCode >= 502) {
      console.warn('[Main2] Network glitch detected; attempting fast recovery retry...');
      await new Promise(r => setTimeout(r, 200));
      response = await execute();
    } else {
      throw err;
    }
  }

  // Safe diagnostic log: HTTP status
  console.log(`[Diagnostic] Main2 HTTP status: ${response.status}`);

  if (response.status === 401 || response.status === 403) {
    console.error(`[Main2] Authentication failed with status ${response.status}`);
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      502,
      'MAIN2_AUTH_FAILED'
    );
  }

  if (response.status >= 500) {
    console.error(`[Main2] Upstream server error with status ${response.status}`);
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      503,
      'MAIN2_SERVER_ERROR'
    );
  }

  const body = response.data;
  if (!body) {
    console.error('[Main2] Failed to parse JSON response');
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      502,
      'MAIN2_MALFORMED_JSON'
    );
  }

  if (
    body?.status === 'all_providers_failed' ||
    body?.status === 'service_unavailable' ||
    body?.status === 'no_provider_available'
  ) {
    console.error(`[Main2] Provider unavailable status: ${body?.status}`);
    throw new LookupError(
      'The lookup service is temporarily unavailable. Please try again.',
      503,
      'MAIN2_SERVICE_UNAVAILABLE'
    );
  }

  const isSuccessfulMatch = Boolean(
    response.ok &&
    body &&
    body.success === true &&
    (body.status === 'match_found' || Boolean(body.lookup_result)) &&
    typeof body.lookup_result === 'string' &&
    body.lookup_result.trim()
  );

  // Safe diagnostic log: whether Main2 returned valid result
  console.log(`[Diagnostic] Main2 returned valid result: ${isSuccessfulMatch}`);

  const lookupResult = body && typeof body.lookup_result === 'string'
    ? body.lookup_result.trim()
    : '';

  if (!isSuccessfulMatch || !lookupResult) {
    console.warn('[Main2] No matching password credential found');
    throw new LookupError(
      'No matching result was found.',
      404,
      'MAIN2_NO_MATCH'
    );
  }

  return {
    password: lookupResult,
    plaintext: lookupResult,
  };
}

/**
 * In-flight request deduplication map (Singleflight pattern)
 */
const inFlightLookups = new Map();

/**
 * Sequential Orchestration Workflow:
 * 1. Validate student number
 * 2. Validate configuration
 * 3. Call Main1 (extract username, hash)
 * 4. Call Main2 (lookup password)
 * 5. Return minimal { success: true, username, password }
 *
 * @param {unknown} studentNumberInput
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ success: true, username: string, password: string, plaintext: string }>}
 */
async function orchestrateLookup(studentNumberInput, env = process.env) {
  // Step 1: Validate input
  const validStudentNumber = validateStudentNumber(studentNumberInput);

  // If a request for this exact student number is already running, coalesce into the same task
  // (In test environments, each test spins up separate mock upstream servers, so skip coalescing)
  const shouldCoalesce = env.NODE_ENV !== 'test';
  if (shouldCoalesce && inFlightLookups.has(validStudentNumber)) {
    return inFlightLookups.get(validStudentNumber);
  }

  const task = (async () => {
    try {
      // Step 2: Validate configuration
      const { main1Key, main2Key } = validateConfig(env);

      const main1Url = env.MAIN1_API_URL || DEFAULT_MAIN1_URL;
      const main2Url = env.MAIN2_API_URL || DEFAULT_MAIN2_URL;

      // Step 3: Call Main1
      const { username, hash } = await callMain1(validStudentNumber, main1Key, main1Url);

      // Step 4: Call Main2 using the exact hash returned by Main1
      const { password } = await callMain2(hash, main2Key, main2Url);

      // Step 5: Return minimal sanitized payload (hash and raw telemetry are excluded)
      return {
        success: true,
        username,
        password,
        plaintext: password,
      };
    } finally {
      if (shouldCoalesce) {
        inFlightLookups.delete(validStudentNumber);
      }
    }
  })();

  if (shouldCoalesce) {
    inFlightLookups.set(validStudentNumber, task);
  }
  return task;
}

module.exports = {
  LookupError,
  validateStudentNumber,
  validateConfig,
  callMain1,
  callMain2,
  orchestrateLookup,
  prewarmUpstreams,
  fastPostJson,
};
