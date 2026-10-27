/**
 * Admin Dashboard & API Management Client Script
 * Matches Student Login Support Design & Workflow
 */

document.addEventListener('DOMContentLoaded', () => {
  let csrfToken = null;
  let currentUser = null;
  let activeClientKeys = [];
  let currentSnippetLanguage = 'curl';

  const viewLogin = document.getElementById('view-login');
  const viewDashboard = document.getElementById('view-dashboard');
  const alertBox = document.getElementById('alertBox');
  const headerUsername = document.getElementById('headerUsername');

  // Login form elements
  const formLogin = document.getElementById('form-login');
  const inputUsername = document.getElementById('login-username');
  const inputPassword = document.getElementById('login-password');
  const btnLogin = document.getElementById('btn-login');
  const loginError = document.getElementById('login-error');
  const btnLogout = document.getElementById('btn-logout');

  // Metrics elements
  const metricTotal = document.getElementById('metricTotal');
  const metricActive = document.getElementById('metricActive');
  const metricRevoked = document.getElementById('metricRevoked');
  const metricRequests = document.getElementById('metricRequests');

  // Client keys elements
  const clientKeysList = document.getElementById('clientKeysList');
  const refreshClientKeysBtn = document.getElementById('refreshClientKeysBtn');
  const createClientKeyForm = document.getElementById('createClientKeyForm');
  const clientKeyName = document.getElementById('clientKeyName');
  const clientKeyRateLimit = document.getElementById('clientKeyRateLimit');
  const clientKeyExpiration = document.getElementById('clientKeyExpiration');
  const createClientKeyBtn = document.getElementById('createClientKeyBtn');

  // Reveal secret modal elements
  const modalSecretReveal = document.getElementById('modalSecretReveal');
  const revealedSecretKey = document.getElementById('revealedSecretKey');
  const btnCopySecret = document.getElementById('btnCopySecret');
  const btnCloseSecretReveal = document.getElementById('btnCloseSecretReveal');

  // Account form elements
  const accountForm = document.getElementById('accountForm');
  const accCurrentPassword = document.getElementById('accCurrentPassword');
  const accNewUsername = document.getElementById('accNewUsername');
  const accNewPassword = document.getElementById('accNewPassword');
  const accConfirmPassword = document.getElementById('accConfirmPassword');
  const saveAccountBtn = document.getElementById('saveAccountBtn');

  // Snippets elements
  const apiBaseUrlDisplay = document.getElementById('apiBaseUrlDisplay');
  const snippetCode = document.getElementById('snippetCode');
  const copySnippetBtn = document.getElementById('copySnippetBtn');
  const snippetTabButtons = document.querySelectorAll('.snippet-tab-btn');

  if (apiBaseUrlDisplay) {
    apiBaseUrlDisplay.textContent = window.location.origin;
  }

  function showAlert(message, type = 'success') {
    if (!alertBox) return;
    alertBox.textContent = message;
    alertBox.className = `alert-box alert-${type}`;
    alertBox.classList.remove('hidden');

    setTimeout(() => {
      alertBox.classList.add('hidden');
    }, 6000);
  }

  async function apiFetch(url, options = {}) {
    const opts = { ...options };
    opts.credentials = 'include';
    opts.headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    };

    if (csrfToken && ['POST', 'PATCH', 'PUT', 'DELETE'].includes((opts.method || 'GET').toUpperCase())) {
      opts.headers['x-csrf-token'] = csrfToken;
    }

    if (opts.body && typeof opts.body === 'object') {
      opts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(url, opts);

    if (res.status === 401 && !url.includes('/login') && !url.includes('/session')) {
      showLoginView();
      throw new Error('Session expired');
    }

    return res;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(isoStr) {
    if (!isoStr) return 'Never';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoStr;
    }
  }

  // ── Views Management ────────────────────────────────────────────────
  function showLoginView() {
    if (viewDashboard) {
      viewDashboard.classList.add('hidden');
      viewDashboard.setAttribute('hidden', '');
      viewDashboard.style.display = 'none';
    }
    if (viewLogin) {
      viewLogin.classList.remove('hidden');
      viewLogin.removeAttribute('hidden');
      viewLogin.style.display = 'flex';
    }
    window.scrollTo(0, 0);
    currentUser = null;
    csrfToken = null;

    // If on /admin/dashboard or subpath while not logged in, redirect to /admin
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/admin';
    if (currentPath.includes('/dashboard')) {
      window.location.replace('/admin');
    }
  }

  function showDashboardView(username) {
    if (viewLogin) {
      viewLogin.classList.add('hidden');
      viewLogin.setAttribute('hidden', '');
      viewLogin.style.display = 'none';
    }
    if (viewDashboard) {
      viewDashboard.classList.remove('hidden');
      viewDashboard.removeAttribute('hidden');
      viewDashboard.style.display = 'block';
    }
    window.scrollTo(0, 0);
    currentUser = username;
    if (headerUsername) headerUsername.textContent = username;
    if (accNewUsername) accNewUsername.value = username;

    // Ensure URL is /admin/dashboard when authenticated
    const currentPath = window.location.pathname.replace(/\/+$/, '') || '/admin';
    if (!currentPath.includes('/dashboard')) {
      window.history.replaceState(null, '', '/admin/dashboard');
    }

    loadDashboardMetrics();
    loadClientKeys();
  }

  // ── Check Session ───────────────────────────────────────────────────
  async function checkSession() {
    try {
      const res = await apiFetch('/api/admin/session');
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated) {
          csrfToken = data.csrfToken;
          showDashboardView(data.user.username);
          return;
        }
      }
      showLoginView();
    } catch {
      showLoginView();
    }
  }

  // ── Login Form ──────────────────────────────────────────────────────
  formLogin?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (loginError) loginError.classList.add('hidden');
    btnLogin.disabled = true;
    btnLogin.textContent = 'Logging In...';

    const username = inputUsername.value.trim();
    const password = inputPassword.value;

    try {
      const res = await apiFetch('/api/admin/login', {
        method: 'POST',
        body: { username, password },
      });

      const data = await res.json();
      if (res.ok && data.success) {
        csrfToken = data.csrfToken;
        inputPassword.value = '';
        // Navigate to the Dashboard
        window.location.replace('/admin/dashboard');
      } else {
        const msg = data.error?.message || 'Invalid username or password.';
        if (loginError) {
          loginError.textContent = msg;
          loginError.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (loginError) {
        loginError.textContent = 'Connection error. Please try again.';
        loginError.classList.remove('hidden');
      }
    } finally {
      btnLogin.disabled = false;
      btnLogin.textContent = 'Log In';
    }
  });

  // ── Logout ──────────────────────────────────────────────────────────
  btnLogout?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/admin/logout', { method: 'POST' });
    } finally {
      window.location.replace('/admin');
    }
  });

  // ── Tab Navigation ──────────────────────────────────────────────────
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabTarget = btn.getAttribute('data-tab');

      tabButtons.forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      tabPanes.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');

      const targetPane = document.getElementById(`tab-pane-${tabTarget}`);
      if (targetPane) {
        targetPane.classList.add('active');
      }

      if (tabTarget === 'keys') {
        loadDashboardMetrics();
        loadClientKeys();
      } else if (tabTarget === 'reference') {
        updateCodeSnippets();
      }
    });
  });

  // ── Dashboard Metrics ───────────────────────────────────────────────
  async function loadDashboardMetrics() {
    try {
      const res = await apiFetch('/api/admin/dashboard');
      if (!res.ok) return;
      const data = await res.json();
      if (!data.success) return;

      const s = data.stats;
      if (metricTotal) metricTotal.textContent = s.totalKeys.toLocaleString();
      if (metricActive) metricActive.textContent = s.activeKeys.toLocaleString();
      if (metricRevoked) metricRevoked.textContent = (s.revokedKeys + s.expiredKeys).toLocaleString();
      if (metricRequests) metricRequests.textContent = s.totalRequests.toLocaleString();
    } catch (err) {
      console.error('Failed to load metrics:', err);
    }
  }

  // ── Load Configured Keys ────────────────────────────────────────────
  async function loadClientKeys() {
    if (!clientKeysList) return;

    try {
      clientKeysList.innerHTML = '<p class="empty-state">Loading configured API keys...</p>';
      const res = await apiFetch('/admin/api/client-keys?limit=100');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      activeClientKeys = data.keys || [];
      renderClientKeys(activeClientKeys);
      updateCodeSnippets();
    } catch (err) {
      clientKeysList.innerHTML = `<p class="empty-state">Error loading keys: ${err.message}</p>`;
      showAlert(err.message, 'error');
    }
  }

  function renderClientKeys(keys) {
    if (!clientKeysList) return;
    clientKeysList.innerHTML = '';

    if (keys.length === 0) {
      clientKeysList.innerHTML = '<p class="empty-state">No client API keys created yet. Use the form on the left to generate one.</p>';
      return;
    }

    keys.forEach((key) => {
      const item = document.createElement('div');
      item.className = 'subadmin-item';

      const info = document.createElement('div');
      info.className = 'subadmin-info';

      const nameLine = document.createElement('div');
      nameLine.className = 'subadmin-name';
      nameLine.innerHTML = `
        <span>${escapeHtml(key.name || key.projectName)}</span>
        <span class="status-badge ${key.is_active ? 'status-active' : 'status-disabled'}">
          ${key.is_active ? 'Active' : 'Revoked'}
        </span>
      `;
      info.appendChild(nameLine);

      const keyDisplay = document.createElement('div');
      keyDisplay.style.margin = '6px 0';
      const fullApiKeyValue = (key.api_key || key.fullKey || key.full_key || key.keyPrefix || '').trim();
      keyDisplay.innerHTML = `
        <span class="key-token-box" style="display:inline-flex; align-items:center; justify-content:space-between; gap:10px; word-break:break-all; max-width:100%; padding:6px 10px; background:#f1f5f9; border-radius:4px; border:1px solid #cbd5e1;">
          <code style="word-break:break-all; font-size:0.875rem; color:#1e3a8a; font-weight:600;">${escapeHtml(fullApiKeyValue)}</code>
          <button type="button" class="btn-copy-inline" title="Copy Full API Key" aria-label="Copy Full API Key" style="display:inline-flex; align-items:center; gap:4px; flex-shrink:0; cursor:pointer; font-weight:600; padding:2px 8px; border-radius:4px; border:1px solid #cbd5e1; background:#ffffff;">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            <span class="copy-text">Copy</span>
          </button>
        </span>
      `;
      const copyBtn = keyDisplay.querySelector('.btn-copy-inline');
      const copyTextSpan = copyBtn.querySelector('.copy-text');
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(fullApiKeyValue);
          copyTextSpan.textContent = 'Copied!';
          copyBtn.style.color = '#16a34a';
          showAlert('Full API key copied to clipboard!', 'success');
          setTimeout(() => {
            copyTextSpan.textContent = 'Copy';
            copyBtn.style.color = '';
          }, 2000);
        } catch {
          showAlert('Copied: ' + fullApiKeyValue, 'success');
        }
      });
      info.appendChild(keyDisplay);

      const meta = document.createElement('div');
      meta.className = 'subadmin-meta';
      meta.innerHTML = `
        <span><strong>Rate Limit:</strong> ${key.rate_limit_per_minute || 60} req/min</span> &bull;
        <span><strong>Usage:</strong> ${key.requests_count || 0} calls</span> &bull;
        <span><strong>Last Used:</strong> ${formatDate(key.last_used_at || key.lastUsedAt)}</span>
      `;
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'subadmin-actions';

      // Toggle status button
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'btn btn-sm btn-outline';
      toggleBtn.textContent = key.is_active ? 'Revoke' : 'Activate';
      toggleBtn.onclick = () => toggleClientKey(key.id, key.name || key.projectName);
      actions.appendChild(toggleBtn);

      // Delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-sm btn-danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.onclick = () => deleteClientKey(key.id, key.name || key.projectName);
      actions.appendChild(deleteBtn);

      item.appendChild(info);
      item.appendChild(actions);
      clientKeysList.appendChild(item);
    });
  }

  async function toggleClientKey(keyId, name) {
    try {
      const res = await apiFetch(`/admin/api/client-keys/${keyId}/toggle`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        showAlert(data.message || 'Key status updated.', 'success');
        loadClientKeys();
        loadDashboardMetrics();
      } else {
        showAlert(data.error?.message || data.error || 'Failed to update key status.', 'error');
      }
    } catch (err) {
      showAlert(`Error: ${err.message}`, 'error');
    }
  }

  async function deleteClientKey(keyId, name) {
    if (!confirm(`Are you sure you want to permanently delete the API key for "${name}"? External requests using this key will immediately be rejected.`)) {
      return;
    }

    try {
      const res = await apiFetch(`/admin/api/client-keys/${keyId}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok && data.success) {
        showAlert(data.message || 'Key deleted successfully.', 'success');
        loadClientKeys();
        loadDashboardMetrics();
      } else {
        showAlert(data.error?.message || data.error || 'Failed to delete key.', 'error');
      }
    } catch (err) {
      showAlert(`Error: ${err.message}`, 'error');
    }
  }

  // ── Create Key Form ─────────────────────────────────────────────────
  createClientKeyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const name = clientKeyName.value.trim();
    const rateLimit = parseInt(clientKeyRateLimit.value, 10) || 60;
    const expVal = clientKeyExpiration.value;

    if (!name || name.length < 2) {
      showAlert('Application or client name must be at least 2 characters.', 'error');
      return;
    }

    let expiresAt = null;
    if (expVal !== 'never') {
      const days = parseInt(expVal, 10);
      const d = new Date();
      d.setDate(d.getDate() + days);
      expiresAt = d.toISOString();
    }

    createClientKeyBtn.disabled = true;
    createClientKeyBtn.textContent = 'Generating...';

    try {
      const res = await apiFetch('/admin/api/client-keys', {
        method: 'POST',
        body: {
          name,
          rate_limit_per_minute: rateLimit,
          expiresAt,
        },
      });

      const data = await res.json();
      if (res.ok && data.success) {
        createClientKeyForm.reset();
        clientKeyRateLimit.value = '60';
        clientKeyExpiration.value = 'never';

        // Show Plaintext Secret Modal
        revealedSecretKey.textContent = data.key;
        modalSecretReveal.classList.remove('hidden');

        showAlert('API Key generated successfully! Make sure to copy the secret key.', 'success');
        loadClientKeys();
        loadDashboardMetrics();
      } else {
        showAlert(data.error?.message || data.error || 'Failed to generate key.', 'error');
      }
    } catch (err) {
      showAlert(`Error: ${err.message}`, 'error');
    } finally {
      createClientKeyBtn.disabled = false;
      createClientKeyBtn.textContent = 'Generate API Key';
    }
  });

  refreshClientKeysBtn?.addEventListener('click', () => {
    loadClientKeys();
    loadDashboardMetrics();
  });

  // Modal actions
  btnCopySecret?.addEventListener('click', async () => {
    const text = (revealedSecretKey.textContent || '').trim();
    try {
      await navigator.clipboard.writeText(text);
      const orig = btnCopySecret.textContent;
      btnCopySecret.textContent = '✓ Copied Full Key to Clipboard!';
      showAlert('Full API key copied to clipboard!', 'success');
      setTimeout(() => {
        btnCopySecret.textContent = orig;
      }, 2500);
    } catch {
      showAlert('Key copied: ' + text, 'success');
    }
  });

  btnCloseSecretReveal?.addEventListener('click', () => {
    modalSecretReveal.classList.add('hidden');
  });

  // ── Code Snippets Generation ────────────────────────────────────────
  function getSampleApiKey() {
    const active = activeClientKeys.find((k) => k.is_active);
    return active ? (active.api_key || active.fullKey || active.full_key || active.keyPrefix) : 'sk_support_your_generated_secret_here';
  }

  function updateCodeSnippets() {
    if (!snippetCode) return;

    const origin = window.location.origin || 'https://student-lookup-portal.vercel.app';
    const apiKey = getSampleApiKey();

    const snippets = {
      curl: `curl -X POST "${origin}/api/lookup" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${apiKey}" \\
  -d '{
    "studentNumber": "9599099932"
  }'

# Response:
# {
#   "success": true,
#   "username": "student123",
#   "password": "gaqhf"
# }`,

      python: `import requests

url = "${origin}/api/lookup"
headers = {
    "Content-Type": "application/json",
    "Authorization": f"Bearer {apiKey}"
}
payload = {
    "studentNumber": "9599099932"
}

response = requests.post(url, json=payload, headers=headers)
data = response.json()

if data.get("success"):
    username = data.get("username")
    password = data.get("password")
    print("Username:", username)
    print("Password:", password)
else:
    print("Lookup error:", data.get("error"))`,

      javascript: `// Modern Browser or Node.js 18+ (Fetch API)
async function lookupStudent(studentNumber) {
  const response = await fetch('${origin}/api/lookup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      studentNumber: studentNumber
    })
  });

  const data = await response.json();
  if (data.success) {
    const username = data.username;
    const password = data.password;
    console.log('Username:', username);
    console.log('Password:', password);
  } else {
    console.error('Error:', data.error);
  }
  return data;
}

// Example usage:
lookupStudent('9599099932');`,

      nodejs: `// Node.js with Axios
const axios = require('axios');

async function lookupStudent(studentNumber) {
  try {
    const response = await axios.post('${origin}/api/lookup', {
      studentNumber: studentNumber
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      }
    });

    const data = response.data;
    if (data.success) {
      const username = data.username;
      const password = data.password;
      console.log('Username:', username);
      console.log('Password:', password);
    }
    return data;
  } catch (error) {
    console.error('Request failed:', error.response?.data || error.message);
    throw error;
  }
}

lookupStudent('9599099932')
  .then(res => console.log('Response:', res));`,

      php: `<?php
// PHP cURL Integration Example
$url = "${origin}/api/lookup";
$apiKey = "${apiKey}";

$payload = json_encode([
    "studentNumber" => "9599099932"
]);

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "Content-Type: application/json",
    "Authorization: Bearer " . $apiKey
]);

$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
$username = $data['username'] ?? null;
$password = $data['password'] ?? null;

echo "Username: " . $username . "\n";
echo "Password: " . $password . "\n";`,
    };

    snippetCode.textContent = snippets[currentSnippetLanguage] || snippets.curl;
  }

  snippetTabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      snippetTabButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSnippetLanguage = btn.getAttribute('data-snippet');
      updateCodeSnippets();
    });
  });

  copySnippetBtn?.addEventListener('click', async () => {
    if (!snippetCode) return;
    try {
      await navigator.clipboard.writeText(snippetCode.textContent);
      const orig = copySnippetBtn.textContent;
      copySnippetBtn.textContent = '✓ Copied!';
      setTimeout(() => {
        copySnippetBtn.textContent = orig;
      }, 2000);
    } catch {
      showAlert('Code copied to clipboard!', 'success');
    }
  });

  // ── My Account (Change Username & Password) ─────────────────────────
  accountForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const currentPassword = accCurrentPassword.value.trim();
    const newUsername = accNewUsername.value.trim();
    const newPassword = accNewPassword.value.trim();
    const confirmPassword = accConfirmPassword.value.trim();

    if (!currentPassword) {
      showAlert('Current password is required to save account changes.', 'error');
      return;
    }

    if (newPassword) {
      if (newPassword.length < 6) {
        showAlert('New password must be at least 6 characters long.', 'error');
        return;
      }
      if (newPassword !== confirmPassword) {
        showAlert('New password and confirmation do not match.', 'error');
        return;
      }
    }

    saveAccountBtn.disabled = true;
    saveAccountBtn.textContent = 'Updating...';

    try {
      const payload = {
        current_password: currentPassword,
      };

      if (newUsername) {
        payload.new_username = newUsername;
      }
      if (newPassword) {
        payload.new_password = newPassword;
      }

      const res = await apiFetch('/admin/api/account/update', {
        method: 'POST',
        body: payload,
      });

      const data = await res.json();
      if (res.ok && data.success) {
        showAlert(data.message || 'Credentials updated successfully.', 'success');
        if (data.username && headerUsername) {
          headerUsername.textContent = data.username;
        }
        accCurrentPassword.value = '';
        accNewPassword.value = '';
        accConfirmPassword.value = '';
      } else {
        showAlert(data.error?.message || data.error || 'Failed to update credentials.', 'error');
      }
    } catch (err) {
      showAlert(`Error: ${err.message}`, 'error');
    } finally {
      saveAccountBtn.disabled = false;
      saveAccountBtn.textContent = 'Update Account Credentials';
    }
  });

  // Initialize
  checkSession();
});
