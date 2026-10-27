/**
 * Lookup Service
 * Coordinates the sequential integration workflow:
 * 1. Validate student number (10 numeric digits, string preservation).
 * 2. Query Main1 (Student Login Support) for username and MD5 hash.
 * 3. Query Main2 (Student Credentials Provider) with hash to resolve password.
 * 4. Return exclusively { success: true, username, password }.
 */

const DEFAULT_MAIN1_URL = 'https://student-login-support.vercel.app/api/support/login-diagnostics';
const DEFAULT_MAIN2_URL = 'https://student-credentials-provider.vercel.app/api/v1/lookup';
const REQUEST_TIMEOUT_MS = 18000;

/**
 * Validates input and executes the Main1 -> Main2 integration.
 * @param {unknown} studentNumber
 * @returns {Promise<{ success: boolean, username: string, password: string }>}
 */
async function performLookup(studentNumber) {
  // Step 1: Validate input
  if (
    typeof studentNumber !== 'string' ||
    studentNumber.trim().length !== 10 ||
    !/^\d{10}$/.test(studentNumber.trim())
  ) {
    const error = new Error('Please enter a valid 10-digit number.');
    error.statusCode = 400;
    throw error;
  }

  const cleanStudentNumber = studentNumber.trim();

  // Validate environment configuration
  const main1ApiKey = process.env.MAIN1_API_KEY;
  const main2ApiKey = process.env.MAIN2_API_KEY;

  if (!main1ApiKey || !main2ApiKey) {
    // Log safe diagnostic internally without leaking variable values or keys
    console.error('[LookupService] Upstream API key configuration missing');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 503;
    throw error;
  }

  const main1Url = process.env.MAIN1_API_URL || DEFAULT_MAIN1_URL;
  const main2Url = process.env.MAIN2_API_URL || DEFAULT_MAIN2_URL;

  // Step 2 & 3: Call Main1 to retrieve username and hash
  let main1Response;
  try {
    main1Response = await fetch(main1Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Accept': 'application/json',
        'x-api-key': main1ApiKey,
      },
      body: JSON.stringify({
        studentNumber: cleanStudentNumber,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      keepalive: true,
    });
  } catch (err) {
    console.error('[LookupService] Main1 network/timeout failure');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 503;
    throw error;
  }

  if (main1Response.status === 401 || main1Response.status === 403) {
    console.error('[LookupService] Main1 authentication rejected');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 502;
    throw error;
  }

  let main1Data;
  try {
    main1Data = await main1Response.json();
  } catch {
    console.error('[LookupService] Main1 returned malformed JSON');
    const error = new Error('Unable to retrieve the student details. Please try again.');
    error.statusCode = 502;
    throw error;
  }

  if (
    !main1Response.ok ||
    !main1Data ||
    main1Data.success !== true ||
    typeof main1Data.username !== 'string' ||
    !main1Data.username.trim() ||
    typeof main1Data.hash !== 'string' ||
    !main1Data.hash.trim()
  ) {
    const error = new Error('Unable to retrieve the student details. Please try again.');
    error.statusCode = (main1Response.status === 404 || (main1Data && main1Data.error && main1Data.error.code === 'STUDENT_NOT_FOUND')) ? 404 : 502;
    throw error;
  }

  const username = main1Data.username.trim();
  const hash = main1Data.hash.trim();

  // Step 4 & 5: Call Main2 with extracted hash
  let main2Response;
  try {
    main2Response = await fetch(main2Url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Accept': 'application/json',
        'X-API-Key': main2ApiKey,
      },
      body: JSON.stringify({
        lookup_input: hash,
        algorithm_type: 'md5',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      keepalive: true,
    });
  } catch (err) {
    console.error('[LookupService] Main2 network/timeout failure');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 503;
    throw error;
  }

  if (main2Response.status === 401 || main2Response.status === 403) {
    console.error('[LookupService] Main2 authentication rejected');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 502;
    throw error;
  }

  if (main2Response.status >= 500) {
    console.error('[LookupService] Main2 service failure (status >= 500)');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 503;
    throw error;
  }

  let main2Data;
  try {
    main2Data = await main2Response.json();
  } catch {
    console.error('[LookupService] Main2 returned malformed JSON');
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 502;
    throw error;
  }

  if (
    main2Data?.status === 'all_providers_failed' ||
    main2Data?.status === 'service_unavailable' ||
    main2Data?.status === 'no_provider_available'
  ) {
    const error = new Error('The service is temporarily unavailable. Please try again later.');
    error.statusCode = 503;
    throw error;
  }

  const isMatchFound = (
    main2Response.ok &&
    main2Data &&
    main2Data.success === true &&
    (main2Data.status === 'match_found' || typeof main2Data.lookup_result === 'string')
  );

  const lookupResult = main2Data && typeof main2Data.lookup_result === 'string'
    ? main2Data.lookup_result.trim()
    : '';

  if (!isMatchFound || !lookupResult) {
    const error = new Error('No matching password was found.');
    error.statusCode = 404;
    throw error;
  }

  // Step 6: Return minimal payload
  return {
    success: true,
    username,
    password: lookupResult,
    plaintext: lookupResult,
  };
}

module.exports = {
  performLookup,
};
