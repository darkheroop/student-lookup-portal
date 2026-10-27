/**
 * API Clients for Main1 (Student Login Support) and Main2 (Student Credentials Provider)
 * Implements strict sequential integration, explicit AbortController timeouts,
 * secure error redaction, safe diagnostic logging, and response validation.
 */

const DEFAULT_MAIN1_URL = 'https://student-login-support.vercel.app/api/support/login-diagnostics';
const DEFAULT_MAIN2_URL = 'https://student-credentials-provider.vercel.app/api/v1/lookup';
const REQUEST_TIMEOUT_MS = 12000; // 12-second timeout per external request

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
 * Logs whether each key is configured and specifically which variable is missing,
 * never logging key values.
 * @param {Record<string, string | undefined>} env
 */
function validateConfig(env) {
  const main1Key = env.MAIN1_API_KEY?.trim();
  const main2Key = env.MAIN2_API_KEY?.trim();

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
 * Calls Main1 (Student Login Support) to resolve student number to username and hash.
 * @param {string} studentNumber
 * @param {string} apiKey
 * @param {string} [endpointUrl]
 * @returns {Promise<{ username: string, hash: string }>}
 */
async function callMain1(studentNumber, apiKey, endpointUrl) {
  const targetUrl = endpointUrl || DEFAULT_MAIN1_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Safe diagnostic log: request start
  console.log('[Diagnostic] Main1 request started');

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ studentNumber }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
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
  } finally {
    clearTimeout(timeoutId);
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

  let body;
  try {
    body = await response.json();
  } catch {
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
 * @returns {Promise<{ plaintext: string }>}
 */
async function callMain2(hash, apiKey, endpointUrl) {
  const targetUrl = endpointUrl || DEFAULT_MAIN2_URL;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Safe diagnostic log: request start
  console.log('[Diagnostic] Main2 request started');

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({
        lookup_input: hash,
        algorithm_type: 'md5',
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
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
  } finally {
    clearTimeout(timeoutId);
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

  let body;
  try {
    body = await response.json();
  } catch {
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
    console.warn('[Main2] No matching plaintext credential found');
    throw new LookupError(
      'No matching result was found.',
      404,
      'MAIN2_NO_MATCH'
    );
  }

  return {
    plaintext: lookupResult,
  };
}

/**
 * Sequential Orchestration Workflow:
 * 1. Validate student number
 * 2. Validate configuration
 * 3. Call Main1 (extract username, hash)
 * 4. Call Main2 (lookup plaintext)
 * 5. Return minimal { success: true, username, plaintext }
 *
 * @param {unknown} studentNumberInput
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ success: true, username: string, plaintext: string }>}
 */
async function orchestrateLookup(studentNumberInput, env = process.env) {
  // Step 1: Validate input
  const validStudentNumber = validateStudentNumber(studentNumberInput);

  // Step 2: Validate configuration
  const { main1Key, main2Key } = validateConfig(env);

  const main1Url = env.MAIN1_API_URL || DEFAULT_MAIN1_URL;
  const main2Url = env.MAIN2_API_URL || DEFAULT_MAIN2_URL;

  // Step 3: Call Main1
  const { username, hash } = await callMain1(validStudentNumber, main1Key, main1Url);

  // Step 4: Call Main2 using the exact hash returned by Main1
  const { plaintext } = await callMain2(hash, main2Key, main2Url);

  // Step 5: Return minimal sanitized payload (hash and raw telemetry are excluded)
  return {
    success: true,
    username,
    plaintext,
  };
}

module.exports = {
  LookupError,
  validateStudentNumber,
  validateConfig,
  callMain1,
  callMain2,
  orchestrateLookup,
};
