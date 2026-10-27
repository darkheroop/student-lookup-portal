const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../src/app');
const { _resetRateLimiter } = require('../src/middleware/rateLimiter');

// Helper to spin up local Express app for tests
function startAppServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

// Helper to create a mock upstream server for Main1 and Main2
function createMockUpstreamServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed = {};
        try {
          if (body) parsed = JSON.parse(body);
        } catch {
          // ignore
        }

        const ctx = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: parsed,
        };

        if (req.url === '/main1') {
          return handlers.handleMain1(ctx, res);
        }
        if (req.url === '/main2') {
          return handlers.handleMain2(ctx, res);
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
      });
    });
  });
}

test.beforeEach(() => {
  _resetRateLimiter();
  process.env.NODE_ENV = 'test';
  process.env.MAIN1_API_KEY = 'mock_main1_auth_token';
  process.env.MAIN2_API_KEY = 'mock_main2_auth_token';
});

// Test A: Invalid input
test('Test A: Invalid input rejected with HTTP 400 (neither upstream called)', async () => {
  let main1Called = false;
  let main2Called = false;

  const mockUpstream = await createMockUpstreamServer({
    handleMain1: () => { main1Called = true; },
    handleMain2: () => { main2Called = true; },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  const invalidInputs = [
    '',               // Empty
    '123456789',      // 9 digits (too short)
    '12345678901',    // 11 digits (too long)
    '12345abcde',     // Non-digits
    '9599-09993',     // Hyphens
    null,             // Null
    1234567890,       // Number type
    undefined,        // Missing
  ];

  try {
    for (const input of invalidInputs) {
      const res = await fetch(`${appServer.url}/api/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentNumber: input }),
      });

      const data = await res.json();
      assert.strictEqual(res.status, 400, `Input "${input}" should return 400`);
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.error, 'Please enter a valid 10-digit number.');
    }

    assert.strictEqual(main1Called, false, 'Main1 should never be called for invalid input');
    assert.strictEqual(main2Called, false, 'Main2 should never be called for invalid input');
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test B: Main1 failure
test('Test B: Main1 failure (auth error, server error, timeout, malformed) prevents Main2 call', async () => {
  const failureScenarios = [
    { name: 'Auth failure (401)', status: 401, body: { error: 'Unauthorized' } },
    { name: 'Server error (500)', status: 500, body: { error: 'Internal Error' } },
    { name: 'Malformed JSON', status: 200, raw: 'invalid-json{' },
    { name: 'Unsuccessful status', status: 200, body: { success: false, error: 'Student not found' } },
  ];

  for (const scenario of failureScenarios) {
    let main2Called = false;

    const mockUpstream = await createMockUpstreamServer({
      handleMain1: (ctx, res) => {
        res.statusCode = scenario.status;
        res.setHeader('Content-Type', 'application/json');
        if (scenario.raw) {
          res.end(scenario.raw);
        } else {
          res.end(JSON.stringify(scenario.body));
        }
      },
      handleMain2: () => {
        main2Called = true;
      },
    });

    process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
    process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

    const appServer = await startAppServer();

    try {
      const res = await fetch(`${appServer.url}/api/lookup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentNumber: '9599099932' }),
      });

      const data = await res.json();
      assert.strictEqual(data.success, false, `Scenario ${scenario.name} should fail`);
      assert.strictEqual(main2Called, false, `Main2 must not be called during ${scenario.name}`);
      assert.ok(data.error.length > 0);
    } finally {
      appServer.server.close();
      mockUpstream.server.close();
    }
  }
});

// Test C: Main1 missing hash
test('Test C: Main1 missing hash prevents Main2 call and fabrication', async () => {
  let main2Called = false;

  const mockUpstream = await createMockUpstreamServer({
    handleMain1: (ctx, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        username: 'student123',
        // hash is completely omitted
      }));
    },
    handleMain2: () => {
      main2Called = true;
    },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '9599099932' }),
    });

    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.strictEqual(main2Called, false, 'Main2 must never be called when hash is missing');
    assert.strictEqual(data.hash, undefined);
    assert.strictEqual(data.plaintext, undefined);
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test D: Main2 failure
test('Test D: Main2 failure returns clear, safe error without success', async () => {
  const mockUpstream = await createMockUpstreamServer({
    handleMain1: (ctx, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        username: 'student123',
        hash: 'valid_hash_from_main1',
      }));
    },
    handleMain2: (ctx, res) => {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        status: 'service_unavailable',
        error: 'Upstream decryptor unavailable',
      }));
    },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '9599099932' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 503);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, 'The lookup service is temporarily unavailable. Please try again.');
    assert.strictEqual(data.plaintext, undefined);
    assert.strictEqual(data.hash, undefined);
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test E: Full success
test('Test E: Full success returns only username and plaintext', async () => {
  let passedHashToMain2 = null;
  let receivedHeaderMain1 = null;
  let receivedHeaderMain2 = null;

  const mockUpstream = await createMockUpstreamServer({
    handleMain1: (ctx, res) => {
      receivedHeaderMain1 = ctx.headers['x-api-key'];
      assert.strictEqual(ctx.body.studentNumber, '9599099932');

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        username: 'student123',
        hash: '337b2ac65e5bb92c1f49b6b76b0788b3',
        diagnostics: { requestId: 'req-123' },
      }));
    },
    handleMain2: (ctx, res) => {
      receivedHeaderMain2 = ctx.headers['x-api-key'];
      passedHashToMain2 = ctx.body.lookup_input;
      assert.strictEqual(ctx.body.algorithm_type, 'md5');

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        status: 'match_found',
        lookup_input: '337b2ac65e5bb92c1f49b6b76b0788b3',
        algorithm_type: 'md5',
        lookup_result: 'example-result',
        provider_name: 'md5decrypt',
      }));
    },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '9599099932' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.username, 'student123');
    assert.strictEqual(data.plaintext, 'example-result');
    assert.strictEqual(data.hash, undefined, 'Hash must never be exposed');
    assert.strictEqual(data.diagnostics, undefined, 'Diagnostics must not be exposed');
    assert.strictEqual(passedHashToMain2, '337b2ac65e5bb92c1f49b6b76b0788b3');
    assert.strictEqual(receivedHeaderMain1, 'mock_main1_auth_token');
    assert.strictEqual(receivedHeaderMain2, 'mock_main2_auth_token');
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test F: Missing API keys
test('Test F: Missing API keys returns safe configuration error without secret leakage', async () => {
  delete process.env.MAIN1_API_KEY;
  delete process.env.MAIN2_API_KEY;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '9599099932' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 503);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, 'The service is not configured correctly. Please contact the administrator.');
    assert.strictEqual(JSON.stringify(data).includes('API_KEY'), false);
  } finally {
    appServer.server.close();
  }
});

// Test G: Frontend integration elements check
test('Test G: Frontend integration files and relative endpoints check', () => {
  const htmlPath = path.join(__dirname, '../public/index.html');
  const jsPath = path.join(__dirname, '../public/app.js');

  const html = fs.readFileSync(htmlPath, 'utf-8');
  const js = fs.readFileSync(jsPath, 'utf-8');

  // Verify UI elements
  assert.ok(html.includes('<h1 class="title">Lookup</h1>'), 'Heading must be Lookup');
  assert.ok(html.includes('id="studentNumber"'), 'Student number input must exist');
  assert.ok(html.includes('id="submitBtn"'), 'Submit button must exist');
  assert.ok(html.includes('id="loadingIndicator"'), 'Loading indicator must exist');
  assert.ok(html.includes('id="errorMessage"'), 'Error message area must exist');
  assert.ok(html.includes('id="resultArea"'), 'Result area must exist');
  assert.ok(html.includes('id="resultUsername"'), 'Username result element must exist');
  assert.ok(html.includes('id="resultPassword"'), 'Password result element must exist');
  assert.ok(html.includes('Password:'), 'Result label must be Password');
  assert.ok(html.includes('id="copyUsernameBtn"'), 'Copy username button must exist');
  assert.ok(html.includes('id="copyPasswordBtn"'), 'Copy password button must exist');

  // Verify frontend script calls relative URL /api/lookup
  assert.ok(js.includes("fetch('/api/lookup'") || js.includes('fetch("/api/lookup"'), 'Must call relative /api/lookup');
  assert.ok(js.includes('textContent'), 'Must use safe DOM rendering');
  assert.ok(js.includes('finally'), 'Must re-enable submit in finally block');
  assert.ok(js.includes('Username copied!'), 'Must show Username copied feedback');
  assert.ok(js.includes('Password copied!'), 'Must show Password copied feedback');
});

// Test H: No-match response
test('Test H: Main2 no-match response returns clear message without fabrication', async () => {
  const mockUpstream = await createMockUpstreamServer({
    handleMain1: (ctx, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        username: 'student123',
        hash: 'unmatched_hash',
      }));
    },
    handleMain2: (ctx, res) => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false,
        status: 'no_match',
        error: 'Hash not found in rainbow tables',
      }));
    },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '9599099932' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 404);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, 'No matching result was found.');
    assert.strictEqual(data.plaintext, undefined);
    assert.strictEqual(data.hash, undefined);
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test I: Leading zeros preservation
test('Test I: Leading zeros are preserved as a string throughout workflow', async () => {
  let receivedStudentNumber = null;

  const mockUpstream = await createMockUpstreamServer({
    handleMain1: (ctx, res) => {
      receivedStudentNumber = ctx.body.studentNumber;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        username: 'studentZero',
        hash: 'hashZero',
      }));
    },
    handleMain2: (ctx, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: true,
        status: 'match_found',
        lookup_result: 'secretZero',
      }));
    },
  });

  process.env.MAIN1_API_URL = `${mockUpstream.url}/main1`;
  process.env.MAIN2_API_URL = `${mockUpstream.url}/main2`;

  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentNumber: '0123456789' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(receivedStudentNumber, '0123456789');
    assert.strictEqual(typeof receivedStudentNumber, 'string');
    assert.strictEqual(receivedStudentNumber.startsWith('0'), true);
  } finally {
    appServer.server.close();
    mockUpstream.server.close();
  }
});

// Test J: Method Not Allowed
test('Test J: Unsupported HTTP method returns 405 with Allow header', async () => {
  const appServer = await startAppServer();

  try {
    const res = await fetch(`${appServer.url}/api/lookup`, {
      method: 'GET',
    });

    const data = await res.json();
    assert.strictEqual(res.status, 405);
    assert.strictEqual(data.success, false);
    assert.strictEqual(res.headers.get('allow'), 'POST');
  } finally {
    appServer.server.close();
  }
});

// Test K: Static assets security check
test('Test K: No API keys or private endpoints exist in public assets', () => {
  const publicDir = path.join(__dirname, '../public');
  const files = fs.readdirSync(publicDir);

  assert.ok(files.length > 0);

  for (const file of files) {
    const content = fs.readFileSync(path.join(publicDir, file), 'utf-8');

    assert.strictEqual(content.includes('MAIN1_API_KEY'), false, `MAIN1_API_KEY in ${file}`);
    assert.strictEqual(content.includes('MAIN2_API_KEY'), false, `MAIN2_API_KEY in ${file}`);
    assert.strictEqual(content.includes('x-api-key'), false, `x-api-key in ${file}`);
    assert.strictEqual(content.includes('X-API-Key'), false, `X-API-Key in ${file}`);
    assert.strictEqual(content.includes('student-login-support.vercel.app'), false, `Private URL in ${file}`);
    assert.strictEqual(content.includes('student-credentials-provider.vercel.app'), false, `Private URL in ${file}`);
  }
});
