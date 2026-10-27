const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/app');

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

function parseCookies(res) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const cookies = {};
  for (const c of setCookie) {
    const parts = c.split(';')[0].split('=');
    if (parts.length >= 2) {
      cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
    }
  }
  return cookies;
}

test('Admin Auth: Rejects invalid credentials with HTTP 401', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'wrong_user', password: 'wrong_password' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 401);
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error.code, 'INVALID_CREDENTIALS');
  } finally {
    appServer.server.close();
  }
});

test('Admin Auth: Rejects empty credentials with HTTP 400', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: '', password: '' }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 400);
    assert.strictEqual(data.success, false);
  } finally {
    appServer.server.close();
  }
});

test('Admin Auth: Authenticates default admin and returns session token and cookies', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'inexpert_trifler',
        password: 'om sai 0987654321',
      }),
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.ok(data.token, 'Should return session token');
    assert.ok(data.csrfToken, 'Should return CSRF token');
    assert.strictEqual(data.user.username, 'inexpert_trifler');

    const cookies = parseCookies(res);
    assert.ok(cookies.admin_session, 'Should set admin_session cookie');
    assert.ok(cookies.admin_csrf, 'Should set admin_csrf cookie');
  } finally {
    appServer.server.close();
  }
});

test('Admin Session: Unauthenticated session check returns authenticated: false', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/session`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.authenticated, false);
  } finally {
    appServer.server.close();
  }
});

test('Admin Session: Authenticated session check with Bearer token succeeds', async () => {
  const appServer = await startAppServer();
  try {
    // 1. Log in
    const loginRes = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'inexpert_trifler',
        password: 'om sai 0987654321',
      }),
    });
    const loginData = await loginRes.json();
    const token = loginData.token;

    // 2. Check session with Bearer header
    const sessionRes = await fetch(`${appServer.url}/api/admin/session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sessionData = await sessionRes.json();
    assert.strictEqual(sessionData.authenticated, true);
    assert.strictEqual(sessionData.user.username, 'inexpert_trifler');
    assert.ok(sessionData.csrfToken);
  } finally {
    appServer.server.close();
  }
});

test('Admin Protected Routes: Rejects unauthenticated requests with HTTP 401', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/dashboard`);
    assert.strictEqual(res.status, 401);
  } finally {
    appServer.server.close();
  }
});

test('Admin API Keys: CRUD and Toggle operations with CSRF protection', async () => {
  const appServer = await startAppServer();
  try {
    // 1. Log in
    const loginRes = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'inexpert_trifler',
        password: 'om sai 0987654321',
      }),
    });
    const loginData = await loginRes.json();
    const token = loginData.token;
    const csrfToken = loginData.csrfToken;
    const cookies = parseCookies(loginRes);
    const cookieHeader = `admin_session=${cookies.admin_session}; admin_csrf=${cookies.admin_csrf}`;

    // 2. Cookie auth without CSRF token should fail with 403
    const failCsrfRes = await fetch(`${appServer.url}/admin/api/client-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ name: 'CSRF Fail Test App' }),
    });
    assert.strictEqual(failCsrfRes.status, 403);
    const failCsrfData = await failCsrfRes.json();
    assert.strictEqual(failCsrfData.error.code, 'CSRF_MISMATCH');

    // 3. Create key with valid Bearer token (or cookie + x-csrf-token)
    const createRes = await fetch(`${appServer.url}/admin/api/client-keys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        name: 'Test Mobile App',
        rate_limit_per_minute: 120,
      }),
    });

    assert.strictEqual(createRes.status, 201);
    const createData = await createRes.json();
    assert.strictEqual(createData.success, true);
    assert.ok(createData.key.startsWith('sk_support_'), 'Plaintext secret should start with sk_support_');
    assert.strictEqual(createData.record.name, 'Test Mobile App');
    assert.strictEqual(createData.record.is_active, true);
    const keyId = createData.record.id;

    // 4. List keys
    const listRes = await fetch(`${appServer.url}/admin/api/client-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.strictEqual(listData.success, true);
    assert.ok(listData.keys.some(k => k.id === keyId));

    // 5. Toggle key status (active -> disabled)
    const toggleRes = await fetch(`${appServer.url}/admin/api/client-keys/${keyId}/toggle`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    assert.strictEqual(toggleRes.status, 200);
    const toggleData = await toggleRes.json();
    assert.strictEqual(toggleData.success, true);
    assert.strictEqual(toggleData.key.status, 'disabled');

    // 6. Delete key
    const deleteRes = await fetch(`${appServer.url}/admin/api/client-keys/${keyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(deleteRes.status, 200);
    const deleteData = await deleteRes.json();
    assert.strictEqual(deleteData.success, true);

    // 7. Verify key no longer in list
    const listRes2 = await fetch(`${appServer.url}/admin/api/client-keys`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData2 = await listRes2.json();
    assert.strictEqual(listData2.keys.some(k => k.id === keyId), false);
  } finally {
    appServer.server.close();
  }
});

test('Admin UI: Serves admin HTML page on /admin and /admin/dashboard', async () => {
  const appServer = await startAppServer();
  try {
    const res1 = await fetch(`${appServer.url}/admin`);
    assert.strictEqual(res1.status, 200);
    const text1 = await res1.text();
    assert.ok(text1.includes('Admin Dashboard — Student Lookup Portal'));
    assert.ok(text1.includes('form-login'));

    const res2 = await fetch(`${appServer.url}/admin/dashboard`);
    assert.strictEqual(res2.status, 200);
    const text2 = await res2.text();
    assert.ok(text2.includes('Student Lookup Portal'));
  } finally {
    appServer.server.close();
  }
});

test('Admin Account: Updates credentials with current password verification and allows re-login', async () => {
  const appServer = await startAppServer();
  try {
    // 1. Initial login
    const loginRes = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'inexpert_trifler',
        password: 'om sai 0987654321',
      }),
    });
    const loginData = await loginRes.json();
    const token = loginData.token;

    // 2. Attempt update with wrong current password
    const failUpdateRes = await fetch(`${appServer.url}/admin/api/account/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        current_password: 'wrong_current_password',
        new_password: 'new_secret_password_123',
      }),
    });
    assert.strictEqual(failUpdateRes.status, 400);

    // 3. Attempt update with correct password
    const successUpdateRes = await fetch(`${appServer.url}/admin/api/account/update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        current_password: 'om sai 0987654321',
        new_username: 'super_admin_updated',
        new_password: 'new_secret_password_123',
      }),
    });
    assert.strictEqual(successUpdateRes.status, 200);
    const updateData = await successUpdateRes.json();
    assert.strictEqual(updateData.success, true);
    assert.strictEqual(updateData.username, 'super_admin_updated');

    // 4. Verify login with old credentials fails
    const oldLoginRes = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'inexpert_trifler',
        password: 'om sai 0987654321',
      }),
    });
    assert.strictEqual(oldLoginRes.status, 401);

    // 5. Verify login with new credentials succeeds
    const newLoginRes = await fetch(`${appServer.url}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'super_admin_updated',
        password: 'new_secret_password_123',
      }),
    });
    assert.strictEqual(newLoginRes.status, 200);
    const newLoginData = await newLoginRes.json();
    assert.strictEqual(newLoginData.success, true);
    assert.strictEqual(newLoginData.user.username, 'super_admin_updated');
  } finally {
    appServer.server.close();
  }
});

test('Admin Logout: Clears session cookies', async () => {
  const appServer = await startAppServer();
  try {
    const res = await fetch(`${appServer.url}/api/admin/logout`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);

    const cookies = parseCookies(res);
    // When clearing cookies, max-age is set to 0 or expires in past
    assert.ok(res.headers.get('set-cookie').includes('admin_session=;') || res.headers.get('set-cookie').includes('Expires=Thu, 01 Jan 1970'));
  } finally {
    appServer.server.close();
  }
});
