# Lookup — Minimal Integration Website for Main1 and Main2 APIs

A lightweight, standalone, and responsive web application that connects two independent external APIs in sequence:
1. **Main1:** `https://student-login-support.vercel.app` (Student Login Support)
2. **Main2:** `https://student-credentials-provider.vercel.app` (Student Credentials Provider)

The web application provides a single-page interface with one 10-digit number input field and a Submit button. The backend handles the sequential integration securely, preventing secrets and intermediate hashes from ever reaching the browser.

---

## 1. Sequential Integration Architecture

```
[Browser Client]
       │
       │ 1. Submits 10-digit number via POST /api/lookup
       ▼
[Serverless Function: api/lookup.js]
       │
       │ 2. Validates 10-digit numeric string (preserves leading zeros)
       │ 3. Verifies MAIN1_API_KEY & MAIN2_API_KEY presence
       │
       │ 4. Calls Main1: POST /api/support/login-diagnostics (x-api-key: MAIN1_API_KEY)
       ▼
[Main1: Student Login Support]
       │
       │ 5. Returns { success: true, username: "...", hash: "..." }
       ▼
[Serverless Function: api/lookup.js]
       │
       │ 6. Validates Main1 response (halts workflow if invalid/missing)
       │
       │ 7. Calls Main2: POST /api/v1/lookup (X-API-Key: MAIN2_API_KEY, algorithm: "md5")
       ▼
[Main2: Student Credentials Provider]
       │
       │ 8. Returns { success: true, status: "match_found", lookup_result: "..." }
       ▼
[Serverless Function: api/lookup.js]
       │
       │ 9. Validates Main2 match; extracts lookup_result as password
       │ 10. Returns ONLY { success: true, username: "...", password: "..." }
       ▼
[Browser Client]
       Displays Username and Password safely using DOM textContent.
```

---

## 2. Project Structure

```text
new-api-bridge/
├── api/
│   ├── index.js          # Vercel Serverless Function entry point
│   └── lookup.js         # Vercel Serverless Function route for POST /api/lookup
├── lib/
│   └── apiClients.js     # External API clients, validation, AbortController timeouts
├── public/
│   ├── index.html        # Clean UI with "Lookup" heading, input, spinner, error, and result
│   ├── style.css         # Modern, responsive CSS (mobile & desktop)
│   ├── styles.css        # Backward-compatible stylesheet alias
│   └── app.js           # Client-side validation, duplicate prevention, and textContent rendering
├── src/
│   ├── app.js            # Express app mounting /api/lookup and static files for local development
│   └── middleware/
│       └── rateLimiter.js# Abuse prevention rate limiter
├── tests/
│   └── lookup.test.js    # Automated mock-based test suite (Tests A through K)
├── .env.example          # Environment variable placeholders
├── .gitignore            # Git exclusion rules (ignores .env and node_modules)
├── package.json          # Project metadata and test scripts
├── vercel.json           # Vercel deployment configuration
├── server.js             # Local development server runner
└── README.md             # Documentation and usage guide
```

---

## 3. Required Environment Variables

Create a local `.env` file (never commit to version control):

```dotenv
MAIN1_API_KEY=replace_with_authorized_main1_key
MAIN2_API_KEY=replace_with_authorized_main2_key
```

### Variable Reference

| Variable | Required | Description |
| :--- | :---: | :--- |
| `MAIN1_API_KEY` | **Yes** | Authorized API key for Main1 (`https://student-login-support.vercel.app`) |
| `MAIN2_API_KEY` | **Yes** | Authorized API key for Main2 (`https://student-credentials-provider.vercel.app`) |
| `MAIN1_API_URL` | No | Overrides Main1 endpoint (default: `https://student-login-support.vercel.app/api/support/login-diagnostics`) |
| `MAIN2_API_URL` | No | Overrides Main2 endpoint (default: `https://student-credentials-provider.vercel.app/api/v1/lookup`) |
| `PORT` | No | Local development server port (default: `3000`) |

---

## 4. Local Development

### Prerequisites
- Node.js (v18+)
- npm (v9+)

### Setup & Run
```bash
# 1. Install dependencies
cd new-api-bridge
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your authorized API keys

# 3. Start local development server
npm start
```

Open `http://localhost:3000` in your web browser.

---

## 5. Automated Tests

All integration scenarios are tested against mock servers without sending traffic to real student databases or requiring live credentials.

```bash
npm test
```

### Verified Test Cases:
- **Test A: Invalid Input** — Inputs with non-digits, fewer than 10 digits, or more than 10 digits return HTTP 400 without contacting upstream APIs.
- **Test B: Main1 Failure** — Simulates 401 auth failure, 500 server error, malformed JSON, and false success; verifies Main2 is never called.
- **Test C: Main1 Missing Hash** — Verifies that missing hash values halt the workflow and prevent credential fabrication.
- **Test D: Main2 Failure** — Simulates 503 service unavailable and network errors; returns safe error without displaying partial success.
- **Test E: Full Success** — Validates end-to-end extraction: Main1 username + Main2 password returned cleanly.
- **Test F: Missing API Keys** — Verifies safe 503 response without leaking secret names.
- **Test G: Frontend Integration** — Verifies UI elements (heading "Lookup", input, button, loading indicator, result container) and relative `/api/lookup` endpoint.
- **Test H: No-Match Response** — Verifies Main2 no-match responses return clear user-friendly messages without fabricating results.
- **Test I: Leading Zeros** — Verifies numbers starting with `0` (e.g. `0123456789`) are preserved as strings.
- **Test J: Method Not Allowed** — Verifies GET/PUT requests to `/api/lookup` return HTTP 405 with `Allow: POST`.
- **Test K: Static Asset Security** — Scans all `public/` files to ensure no API keys or upstream URLs exist on the client.

---

## 6. Vercel Deployment

1. Install Vercel CLI (or connect the GitHub repository):
   ```bash
   npm i -g vercel
   ```

2. From `new-api-bridge`, deploy:
   ```bash
   vercel
   ```

3. Configure secrets in Vercel:
   ```bash
   vercel env add MAIN1_API_KEY production
   vercel env add MAIN2_API_KEY production
   ```

4. Deploy to production:
   ```bash
   vercel --prod
   ```

---

## 7. Testing With Live APIs

Once authorized credentials are provided:
1. Set `MAIN1_API_KEY` and `MAIN2_API_KEY` in `.env` (or Vercel Environment Variables).
2. Enter a verified 10-digit student number authorized by the API owners.
3. Click **Submit** — the application will automatically query Main1, pass the MD5 hash to Main2, and render the student username and decrypted password.
