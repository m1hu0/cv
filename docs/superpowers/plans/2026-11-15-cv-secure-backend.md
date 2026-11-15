# CV Secure Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the CV editor behind a Cloudflare Worker that holds the CV (encrypted, every version kept) and the Gemini key, and only lets the father's paired phone/tablet in with a PIN.

**Architecture:** The static site stays on GitHub Pages; it talks to a Worker (`cv-api`, D1 database `cv`) over JSON with a bearer session token. Devices prove identity by signing a server nonce with a non-extractable ECDSA key kept in IndexedDB; the PIN is checked only after that signature verifies. The owner runs `worker/admin.mjs` on his PC for pairing, approval, unlock, PIN, import and export.

**Tech Stack:** Cloudflare Workers (plain `fetch` handler, ES modules), D1, WebCrypto (Worker and browser), wrangler 4 via `npx`, vitest + `@cloudflare/vitest-pool-workers` for Worker tests, `node --test` for client modules, existing vanilla JS front end (jsPDF, pdf.js vendored in `lib/`).

**Spec:** `docs/superpowers/specs/2026-11-15-cv-secure-backend-design.md`

## Global Constraints

- No secret (`GEMINI_KEY`, `DATA_KEY`, `ADMIN_TOKEN`, `CONTACT_TEXT`, PIN, device/session tokens) and no personal CV data ever in the repo, in `wrangler.toml`, in logs, or on GitHub Pages. Repo `m1hu0/cv` is **public**.
- Secrets are entered by the owner himself (`npx wrangler secret put …`) or piped straight from a generator into wrangler; Claude never sees `GEMINI_KEY` or the PIN.
- Allowed origin: exactly `https://m1hu0.github.io` in production (`ALLOWED_ORIGIN` var; local dev `http://localhost:8000`). Auth via `Authorization` header only, never cookies.
- Every Worker response: JSON, `Cache-Control: no-store`, no stack traces; unknown errors → `500 {"error":"server"}`.
- PIN: ≥6 digits; PBKDF2-SHA256, 100 000 iterations (Workers' WebCrypto maximum), 16-byte random salt, constant-time compare.
- Lockout: per device 5 wrong → 15 min, each further lock doubles; 10 wrong since last success → `locked` until owner unlock. Global: 20 wrong in 24 h → global lock until owner unlock. Pairing: 3 wrong PINs burn the code (and count toward global).
- Pairing code: 128-bit random, stored as SHA-256, 24 h expiry, single use, only one open code (new one cancels old). Link format `https://m1hu0.github.io/cv/#pair=<code>`.
- Devices: max 3 non-revoked; new ones `pending` until `admin.mjs approve`.
- Challenge nonce: 32 bytes, 60 s TTL, single use. Session: 256-bit, stored hashed, 30 min idle / 8 h max, kept in page memory only.
- CV at rest: AES-256-GCM with `DATA_KEY`, random 12-byte IV per row. Request body cap 1.5 MB → `413`.
- Translate: structured input only, input ≤ 8 KB, ≤ 300 calls/day (UTC day), models `["gemini-flash-latest","gemini-2.5-flash","gemini-flash-lite-latest"]`.
- All user-facing copy in Romanian, existing style: big buttons, 19 px text.
- `.gitignore` must exclude `.dev.vars`, `.wrangler/`, `node_modules/`, and every `*.json` except `manifest.json`, `worker/package.json`, `worker/package-lock.json`.

## Review Focus

1. **Session expires while he is editing** (30 min idle in the editor modal): the next API call gets `401`; the page must ask only for the PIN, keep every in-memory edit, and retry the pending save. → test in Task 9 (`api.js` retries after `onAuthLost` resolves) and manual check in Task 11.
2. **Connection drops during "Salvează"**: no edit is lost from memory, he sees "Nu ai internet…", no PDF is produced, pressing again works. → test in Task 9 (`offline` error code), manual check in Task 11.
3. **Stale tablet auto-saves over phone edits**: auto-save carries `basedOn`; server stores it but keeps the newer one latest, page reloads latest and says so. → test in Task 6 (`auto save on stale base is not latest`).
4. **iOS share sheet after async work**: `navigator.share` needs a fresh tap; after translating/saving the page must show a "📄 Salvează PDF-ul" button rather than calling share directly. → manual check on iPhone in Task 12; code rule in Task 11.
5. **Leftovers from the old version on his devices** (CV and Gemini key in `localStorage`, old `#key=` links): wiped on start, `#key=` stripped and ignored. → test in Task 9 (`purgeLegacy`), manual check in Task 11.

---

## File Structure

```
.gitignore                      new: secrets/backups/build output exclusions
index.html                      modify: CSP meta, module scripts, save button, gate root
app.js                          modify: drop key/localStorage/backup/welcome/Google fallback; use api.js; save+PDF; history
api.js                          new (ES module): Worker client, session, auth-lost retry, legacy purge
device.js                       new (ES module): ECDSA key create/load (IndexedDB), sign, platform detect
gate.js                         new (ES module): pairing / install / paste-code / PIN / pending / locked / offline screens
img/howto-ios-*.svg, img/howto-android.svg   new: drawn step illustrations
test/client.test.mjs            new: node --test for api.js and device.js signing
worker/package.json, worker/package-lock.json, worker/wrangler.toml, worker/vitest.config.js
worker/migrations/0001_init.sql D1 schema
worker/src/index.js             router, CORS, errors, body cap
worker/src/crypto.js            random, hashes, PBKDF2, AES-GCM, ECDSA verify, constant-time compare
worker/src/db.js                small D1 helpers, settings get/set, audit()
worker/src/admin.js             /admin/* endpoints + admin auth/rate limit
worker/src/auth.js              /pair, /challenge, /login, /logout, session middleware, lockout
worker/src/cv.js                /cv, /versions*
worker/src/translate.js         prompts (moved from app.js), validation, Gemini call, daily limit
worker/test/*.test.js           vitest-pool-workers tests, one file per src module
worker/admin.mjs                owner CLI (Node, no deps)
```

---

### Task 1: Worker scaffold and crypto helpers

**Files:**
- Create: `.gitignore`, `worker/package.json`, `worker/wrangler.toml`, `worker/vitest.config.js`, `worker/src/crypto.js`
- Test: `worker/test/crypto.test.js`

**Interfaces:**
- Produces (`worker/src/crypto.js`):
  - `randomToken(bytes: number): string` — base64url
  - `sha256hex(s: string): Promise<string>`
  - `safeEqual(a: string, b: string): boolean` — constant time
  - `hashPin(pin: string, saltB64?: string): Promise<{hash: string, salt: string}>` — PBKDF2 100 000
  - `verifyPin(pin: string, hash: string, salt: string): Promise<boolean>`
  - `encryptJson(obj: any, keyB64: string): Promise<{iv: string, blob: string}>`
  - `decryptJson(iv: string, blob: string, keyB64: string): Promise<any>`
  - `verifySignature(publicJwk: object, data: string, sigB64url: string): Promise<boolean>` — ECDSA P-256 / SHA-256, raw (IEEE P1363) signature as WebCrypto produces

- [ ] **Step 1:** Create `worker/package.json` (`"type":"module"`, scripts `test: vitest run`, `dev: wrangler dev`, `deploy: wrangler deploy`), devDependencies `wrangler@4`, `vitest`, `@cloudflare/vitest-pool-workers` at mutually compatible current versions; run `npm install` in `worker/`. `wrangler.toml`: `name="cv-api"`, `main="src/index.js"`, current `compatibility_date`, `[vars] ALLOWED_ORIGIN="https://m1hu0.github.io"`, `[[d1_databases]] binding="DB" database_name="cv" database_id="TO_FILL_AT_DEPLOY" migrations_dir="migrations"`. `vitest.config.js` uses `defineWorkersConfig` with `wrangler.configPath`, D1 migrations applied in setup, and test bindings `DATA_KEY`, `ADMIN_TOKEN`, `GEMINI_KEY`, `CONTACT_TEXT`, `ALLOWED_ORIGIN="http://localhost:8000"`. Write root `.gitignore` per Global Constraints.
- [ ] **Step 2: Write the failing tests** in `worker/test/crypto.test.js`:
  - `randomToken(16)` decodes to 16 bytes; two calls differ.
  - `verifyPin("123456", …hashPin("123456"))` true; `verifyPin("123457", …)` false; two `hashPin` of same PIN have different salts.
  - `decryptJson(…encryptJson({a:"ă"}, k), k)` deep-equals `{a:"ă"}`; decrypt with another key rejects; two encryptions of same object have different `iv`.
  - `verifySignature`: generate a P-256 key in the test, sign `"nonce"`, export public JWK → true; signature over `"other"` → false; garbage signature → false (no throw).
  - `safeEqual("abc","abc")` true, `("abc","abd")` false, `("abc","abcd")` false.
- [ ] **Step 3:** Run `npm test` in `worker/` → FAIL (module missing).
- [ ] **Step 4:** Implement `worker/src/crypto.js` with WebCrypto only (`crypto.subtle`, `crypto.getRandomValues`).
- [ ] **Step 5:** Run `npm test` → PASS.
- [ ] **Step 6: Commit** `git add .gitignore worker/ && git commit -m "feat(worker): scaffold and crypto helpers"`

### Task 2: Schema, router, CORS, audit

**Files:**
- Create: `worker/migrations/0001_init.sql`, `worker/src/db.js`, `worker/src/index.js`
- Test: `worker/test/index.test.js`

**Interfaces:**
- Produces:
  - Tables:
    `settings(key TEXT PRIMARY KEY, value TEXT)` — keys `pin_hash`, `pin_salt`, `global_lock` ("1"/absent), `latest_version_id`;
    `devices(id TEXT PK, label TEXT, public_jwk TEXT, status TEXT CHECK(status IN ('pending','active','locked','revoked')), fails_window INT DEFAULT 0, fails_since_success INT DEFAULT 0, lock_level INT DEFAULT 0, locked_until INT DEFAULT 0, created_at INT, last_seen INT)`;
    `pairing_codes(code_hash TEXT PK, label TEXT, expires_at INT, used INT DEFAULT 0, pin_fails INT DEFAULT 0)`;
    `challenges(nonce TEXT PK, device_id TEXT, expires_at INT)`;
    `sessions(token_hash TEXT PK, device_id TEXT, created_at INT, last_used INT)`;
    `pin_failures(id INTEGER PK AUTOINCREMENT, device_id TEXT, at INT)`;
    `versions(id INTEGER PK AUTOINCREMENT, created_at INT, updated_at INT, device_label TEXT, kind TEXT, based_on INT, size INT, iv TEXT, blob TEXT)`;
    `translate_usage(day TEXT PK, count INT)`;
    `audit(id INTEGER PK AUTOINCREMENT, at INT, event TEXT, device_id TEXT, ok INT)`.
    All times are epoch ms from `Date.now()` on the server.
    Audit events written by later tasks: `admin_auth`, `pair`, `login`, `pin_fail`, `lock`, `save`, `restore`, `import`, `approve`, `revoke`, `unlock` (device id + ok only, never codes, PINs, tokens or CV content).
  - `worker/src/db.js`: `getSetting(env, key): Promise<string|null>`, `setSetting(env, key, value|null)`, `audit(env, event: string, deviceId: string|null, ok: boolean)`, `now(): number`.
  - `worker/src/index.js`: `export default { fetch(req, env) }`; `json(status: number, body: object): Response` (exported for modules); route table mapping `METHOD path` → handler `(req, env, ctx) => Response`, where `ctx` = `{ body, device?, session? }` filled by middleware. Later tasks register their routes by exporting a `routes` object `{ "POST /pair": handler, … }` merged here.

- [ ] **Step 1: Write the failing tests** (`SELF.fetch` from `cloudflare:test`):
  - `OPTIONS /cv` with `Origin: http://localhost:8000` → 204, `Access-Control-Allow-Origin` equals that origin, allows `Authorization, Content-Type`.
  - Any request with `Origin: https://evil.example` → 403 `{"error":"origin"}` and no ACAO header.
  - `GET /nope` → 404 `{"error":"not_found"}`, `Cache-Control: no-store`, `Content-Type: application/json`.
  - POST with body > 1.5 MB → 413 `{"error":"too_big"}`.
  - Malformed JSON body → 400 `{"error":"bad_json"}`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Write migration and implement `db.js` and `index.js` (catch-all try/catch → 500 `{"error":"server"}`, `console.error` without request body).
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): schema, router, CORS`

### Task 3: Admin endpoints

**Files:**
- Create: `worker/src/admin.js`
- Modify: `worker/src/index.js` (merge routes)
- Test: `worker/test/admin.test.js`

**Interfaces:**
- Consumes: Task 1 `safeEqual`, `randomToken`, `sha256hex`, `hashPin`; Task 2 db helpers.
- Produces (all require `Authorization: Bearer <ADMIN_TOKEN>`; 10 failed admin auths in the last hour (counted from `audit` event `admin_auth`, ok=0) → every admin call 429 for that hour):
  - `POST /admin/pin {pin}` → 200; 400 `{"error":"weak_pin"}` unless `/^\d{6,}$/`.
  - `POST /admin/pair {label}` → `{code, link, expiresAt}`; deletes other unused codes.
  - `GET /admin/devices` → `[{id,label,status,createdAt,lastSeen,lockedUntil}]`
  - `POST /admin/devices/:id/approve|revoke|unlock` → 200; approve refused 409 `{"error":"too_many_devices"}` if 3 non-revoked active exist; revoke also deletes its sessions; unlock resets counters, lock_level, status→active.
  - `POST /admin/unlock-all` → clears `global_lock` and `pin_failures`.
  - `POST /admin/import {data}` → `{id}` (new version, kind `import`, device label `admin`) — implemented in Task 6, route stubbed here returning 501 until then.
  - `GET /admin/versions`, `GET /admin/versions/:id` — implemented in Task 6.
  - `GET /admin/audit?limit=200` → newest first.

- [ ] **Step 1: Write the failing tests:** missing/wrong bearer → 401 and an `admin_auth` audit row; 11th wrong attempt in an hour → 429 even with the right token; `POST /admin/pin {pin:"12345"}` → 400 `weak_pin`; `{pin:"482913"}` → 200 and `settings.pin_hash` set and ≠ the PIN; two `POST /admin/pair` → first code's row gone, response `link` starts with `https://m1hu0.github.io/cv/#pair=`; approve on a 4th device when 3 active → 409; revoke removes sessions of that device.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement `admin.js`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): admin endpoints`

### Task 4: Device pairing endpoint

**Files:**
- Create: `worker/src/auth.js` (pairing part)
- Test: `worker/test/pair.test.js`

**Interfaces:**
- Consumes: Task 1, Task 2, a PIN set via Task 3 (tests insert `pin_hash/pin_salt` directly).
- Produces: `POST /pair {code, pin, publicKey: JWK}` →
  - 200 `{deviceId, status:"pending", contact: CONTACT_TEXT}` on success (code marked used, device row `pending`).
  - 400 `{"error":"bad_code"}` for unknown / used / expired code (same answer for all three).
  - 403 `{"error":"bad_pin", "left": n}`; on the 3rd failure the code is burned and the answer is `bad_code` from then on. Each failure inserts a `pin_failures` row; reaching 20 in 24 h sets `global_lock`.
  - 423 `{"error":"global_lock"}` (no contact text: the caller is not verified) when `global_lock` set.
  - 400 `{"error":"bad_key"}` unless JWK is `kty:"EC", crv:"P-256"` with `x,y` and no `d`.

- [ ] **Step 1: Write the failing tests** for each bullet above, plus: reusing a successful code → `bad_code`; an expired code (`expires_at` in the past) → `bad_code`; JWK containing `d` → `bad_key`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement in `auth.js`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): device pairing`

### Task 5: Challenge, login, sessions, lockout

**Files:**
- Modify: `worker/src/auth.js`, `worker/src/index.js` (session middleware)
- Test: `worker/test/login.test.js`

**Interfaces:**
- Produces:
  - `POST /challenge {deviceId}` → `{nonce}`; unknown or revoked device → 404 `{"error":"unknown_device"}`.
  - `POST /login {deviceId, nonce, signature, pin}`. Order of checks: nonce exists, belongs to device, unexpired (then delete it) → signature valid (else 401 `{"error":"bad_signature"}`, PIN not evaluated, no failure counted) → global lock → 423 `{"error":"global_lock","contact"}` → status `pending` → 403 `{"error":"pending","contact"}`; `locked` or `locked_until > now` → 423 `{"error":"locked","until"?, "contact"}` → PIN. Wrong PIN → 403 `{"error":"bad_pin","left"}` where `left` = attempts before the next lock. Right PIN → `{session}`, counters reset (`fails_window=0`, `fails_since_success=0`, `lock_level=0`).
  - Lock math: on the 5th failure in a window set `locked_until = now + 15min * 2^lock_level`, `lock_level++`, `fails_window=0`; when `fails_since_success` reaches 10 set status `locked`.
  - `requireSession(req, env): Promise<{deviceId, label}|Response>` used by Task 6/7 routes: bearer token → hash lookup; reject if `now - last_used > 30 min` or `now - created_at > 8 h` (delete row) → 401 `{"error":"session"}`; otherwise bump `last_used` and device `last_seen`.
  - `POST /logout` → deletes session.

- [ ] **Step 1: Write the failing tests:** happy path returns a session usable on a stub protected route; reused nonce → 401; nonce older than 60 s → 401; signature by another key → `bad_signature` and `fails_window` unchanged; pending device → `pending` with `contact`; 5 wrong PINs → 6th call (even right PIN) → 423 with `until ≈ now+15min`; after lock expires (set `locked_until` in the past) another 5 wrong → `until ≈ now+30min`; 10 wrong total → status `locked`, right PIN still 423 until `/admin/devices/:id/unlock`; 20 wrong across 3 devices → `global_lock`; session idle 31 min → 401 `session`; session 8 h old but active → 401.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): login, sessions, lockout`

### Task 6: CV versions

**Files:**
- Create: `worker/src/cv.js`
- Modify: `worker/src/admin.js` (import/versions routes)
- Test: `worker/test/cv.test.js`

**Interfaces:**
- Consumes: `requireSession` (Task 5), `encryptJson/decryptJson` (Task 1).
- Produces (session required):
  - `GET /cv` → `{id, createdAt, data}` for `latest_version_id`, or `{id:null, data:null}`.
  - `POST /cv {data, basedOn: number|null, kind: "manual"|"auto"}` →
    - if `basedOn == latest_version_id` (or both null): if `kind=="auto"` and the latest row is `auto`, same device label, `updated_at` within 10 min → overwrite that row in place (same id, new iv/blob/updated_at); else insert. Returns `{id, latest:true}`.
    - else (stale): insert the row but leave `latest_version_id` unchanged; return `{id, latest:false, current:{id, data}}`.
    - `data` must be an object with `personal` and array `work` → else 400 `{"error":"bad_cv"}`.
  - `GET /versions` → `[{id, createdAt, updatedAt, device, kind, size, latest}]` newest first.
  - `GET /versions/:id` → `{id, createdAt, data}`.
  - `POST /versions/:id/restore {basedOn}` → same result shape as `POST /cv` with `kind:"restore"`.
  - Admin: `POST /admin/import {data}` (kind `import`, becomes latest regardless of base), `GET /admin/versions`, `GET /admin/versions/:id`.

- [ ] **Step 1: Write the failing tests:** first save → latest; `GET /cv` returns same data; D1 `blob` column does not contain the plaintext name string; `auto` twice within 10 min → one row, latest data is the second; `auto` after a `manual` → new row; `manual` twice → two rows; **auto save on stale base is not latest** (save A latest, save B with `basedOn` of the version before A → `latest:false`, `current.id == A`); restore of version 1 creates a new latest whose data equals version 1; `bad_cv` for `{}`; admin import becomes latest; no session → 401.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): encrypted CV versions`

### Task 7: Translation

**Files:**
- Create: `worker/src/translate.js`
- Test: `worker/test/translate.test.js`

**Interfaces:**
- Produces: `POST /translate` (session required) with
  - `{kind:"entry", section:"work"|"education", current: boolean, input:{role, employer, place, subtitle, lines: string[]}}` → `{role, employer, place, subtitle, lines}` with `lines.length === input.lines.length` (else 502 `{"error":"bad_output"}`);
  - `{kind:"personal", input:{name, birth, nationality, phone, email, address}}` → same keys.
  - Prompts: move `RULES` and `styleRule` verbatim from `app.js:96-115` and the personal prompt text from `app.js:199-201` into this file; the client sends no prompt text. Any extra key in `input`, non-string field, or serialized input > 8 KB → 400 `{"error":"bad_input"}`.
  - Daily counter in `translate_usage` (UTC `YYYY-MM-DD`); over 300 → 429 `{"error":"limit"}`.
  - Model fallback as today (`app.js:117-146`): 404/429 → next model; Gemini 400 "api key"/403 → 500 `{"error":"server"}` (never tell the client about the key); all failed → 503 `{"error":"unavailable"}`. Key sent in `x-goog-api-key` header, not the URL.

- [ ] **Step 1: Write the failing tests** with `fetchMock` from `cloudflare:test` intercepting `generativelanguage.googleapis.com`: happy entry path; request carries `x-goog-api-key` and the URL has no `key=`; the outgoing prompt contains `"PAST job"` when `current:false` and `"CURRENT job"` when true; extra input key → `bad_input`; 9 KB input → `bad_input`; first model 429 then second OK → success; all 429 → 503; Gemini returns fewer lines → 502; 301st call of the day → 429 `limit`; no session → 401.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): server-side translation`

### Task 8: Owner CLI `worker/admin.mjs`

**Files:**
- Create: `worker/admin.mjs`, `worker/README.md` (owner commands, in Romanian)

**Interfaces:**
- Consumes: Task 3/6 admin endpoints.
- Produces: `node admin.mjs <command>` with `CV_API` base URL from env or `worker/.cv-api-url` (gitignored) and the admin token read from `%USERPROFILE%\.cv-admin\token` (outside the repo):
  - `init-token` — generate 32-byte token, write it to `%USERPROFILE%\.cv-admin\token`, pipe it to `npx wrangler secret put ADMIN_TOKEN` (stdin), print only "done".
  - `init-data-key` — generate 32-byte key and pipe it to `npx wrangler secret put DATA_KEY`; never printed or stored.
  - `set-pin` — prompt twice with echo off, POST `/admin/pin`.
  - `pair "<label>"` — prints the link and the expiry time.
  - `devices`, `approve <id>`, `revoke <id>`, `unlock <id>`, `unlock-all`, `audit`.
  - `import <file.json>` — validate shape, POST `/admin/import`.
  - `versions`, `export <id> <out.json>` — refuses an output path inside the repo folder.
  - No npm dependencies; Node ≥ 18 (`fetch`, `crypto.randomBytes`, `readline` with muted output).

- [ ] **Step 1:** Implement the CLI.
- [ ] **Step 2: Verify locally:** in `worker/`, create `.dev.vars` with throwaway local values (gitignored), `npx wrangler d1 migrations apply cv --local`, `npx wrangler dev`; with `CV_API=http://localhost:8787` and a local token file run `set-pin`, `pair "test"`, `devices`, `import` of a sample CV made from `EMPTY()` shape, `versions`, `export` to the scratchpad. Expected: each succeeds; `export` into the repo is refused.
- [ ] **Step 3:** `git status` shows no `.dev.vars`, no token, no exported json.
- [ ] **Step 4: Commit** `feat(worker): owner CLI`

### Task 9: Client API and device key modules

**Files:**
- Create: `api.js`, `device.js`, `test/client.test.mjs`

**Interfaces:**
- Produces (`device.js`, ES module):
  - `createDeviceKey(): Promise<JsonWebKey>` — `generateKey({name:"ECDSA",namedCurve:"P-256"}, false, ["sign","verify"])`, store the `CryptoKeyPair` in IndexedDB db `cv-device` store `keys` key `main`, return public JWK.
  - `hasDeviceKey(): Promise<boolean>`, `signNonce(nonce: string): Promise<string>` (base64url), `forgetDevice(): Promise<void>` (also removes `cv-device-id`).
  - `getDeviceId(): string|null`, `setDeviceId(id)` — in `localStorage` key `cv-device-id`.
  - `platform(): "ios"|"android"|"other"`, `isStandalone(): boolean` (`navigator.standalone` or `matchMedia('(display-mode: standalone)')`).
- Produces (`api.js`, ES module):
  - `API_BASE`: `http://localhost:8787` when `location.hostname === "localhost"`, else the deployed Worker URL (constant filled in Task 12).
  - `setAuthLostHandler(fn: () => Promise<void>)`; `request(method, path, body?)` — adds bearer session; on `401 {"error":"session"}` awaits the handler once then retries once; network failure → throws `{code:"offline"}`; non-2xx → throws `{code: body.error, ...body, status}`.
  - `pair(code, pin, publicKey)`, `login(pin)` (challenge → sign → login; stores session in a module variable), `logout()`, `getCv()`, `saveCv(data, basedOn, kind)`, `listVersions()`, `getVersion(id)`, `restoreVersion(id, basedOn)`, `translate(payload)`.
  - `purgeLegacy()` — removes `localStorage` keys `cv-editor-data-v1`, `cv-editor-gemini-key`, and strips any `#key=` from the URL with `history.replaceState`.
- [ ] **Step 1: Write the failing tests** (`node --test test/client.test.mjs`, with `globalThis.fetch`, `localStorage`, `location`, `history` stubbed): `request` retries once after a `session` 401 when the handler resolves, and does not loop on a second 401; fetch rejection → `{code:"offline"}`; `{"error":"bad_pin","left":3}` surfaces as `err.code==="bad_pin" && err.left===3`; `purgeLegacy` removes both legacy keys and turns `/cv/#key=AIza123` into `/cv/`; `signNonce` with an in-memory key (inject via an exported test hook `_setKeyPairForTest`) produces a signature that verifies with WebCrypto against the public key.
- [ ] **Step 2:** Run `node --test test/client.test.mjs` → FAIL.
- [ ] **Step 3:** Implement both modules.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(client): API and device key modules`

### Task 10: Gate screens (pairing, install, PIN, states)

**Files:**
- Create: `gate.js`, `img/howto-ios-1.svg`, `img/howto-ios-2.svg`, `img/howto-ios-3.svg`, `img/howto-android.svg`
- Modify: `index.html` (CSP meta, `<div id="gate">`, `type="module"` scripts)

**Interfaces:**
- Consumes: Task 9.
- Produces: `startGate(): Promise<{cv: object|null, versionId: number|null}>` — resolves only when logged in and the CV is loaded; renders full-screen into `#gate` and hides the editor until then. Also exported `askPinAgain(): Promise<void>` used as the auth-lost handler.

Flow decisions (resolving the spec's "iOS hop" item):
- iOS Home Screen apps don't share storage with Safari, and links from messages open in Safari. So on **iOS in a Safari tab with `#pair=`**: screen 1 "Copiază codul" (writes the code to the clipboard), screens 2-3 drawn steps Share → "Adaugă pe ecranul principal", screen 4 "Deschide iconița CV de pe ecran". In the **installed app with no device key**: "Lipește codul primit" big button (`navigator.clipboard.readText()`, plus a text field fallback) → PIN → pair.
- **Android / other**: pair right away in the browser (installed PWA shares storage with Chrome), then show the "Instalează aplicația" picture (and the `beforeinstallprompt` button when available).
- After pairing: "Gata! {contact}. Spune-i că ai terminat." with a "Verifică din nou" button (tries login with the remembered PIN in memory → `pending` keeps this screen).
- No device key and no code → "Aplicația nu e configurată pe acest telefon. {contact if known else 'Cere linkul de configurare.'}"
- PIN screen: numeric keypad (`inputmode="numeric"`, `autocomplete="off"`), errors: `bad_pin` → "PIN greșit. Mai ai {left} încercări."; `locked` with `until` → "Prea multe încercări. Încearcă din nou la {HH:MM}."; `locked`/`global_lock` without until → "Aplicația e blocată. {contact}"; `offline` → "Nu ai internet. Încearcă din nou." with retry; `unknown_device` → `forgetDevice()` and the not-configured screen.
- CSP meta: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self' <API_BASE origin> http://localhost:8787; object-src 'none'; base-uri 'none'; form-action 'none'` (drop the localhost entry in Task 12).

- [ ] **Step 1:** Implement `gate.js`, illustrations (simple line drawings in the page palette, Romanian labels), and `index.html` changes; call `purgeLegacy()` first thing.
- [ ] **Step 2: Verify in the browser pane** against `wrangler dev` (serve site with `npx http-server -p 8000` or `python -m http.server 8000`): open `http://localhost:8000/#pair=<code from admin.mjs pair>` → code disappears from the address bar; wrong PIN shows "Mai ai 2 încercări."; right PIN → pending screen; `admin.mjs approve` → "Verifică din nou" opens the editor; reload → PIN screen only; 5 wrong PINs → time message; console shows no CSP violations.
- [ ] **Step 3: Commit** `feat(client): pairing and PIN gate`

### Task 11: Editor integration (save, PDF, history, cleanup)

**Files:**
- Modify: `app.js` (sections at `app.js:13-14`, `58-93`, `95-215`, `556-635`, `854-878`), `index.html` (top bar save button)

**Interfaces:**
- Consumes: Task 9 `api.*`, Task 10 `startGate`, `askPinAgain`.
- Produces in `app.js`: `saveNow(kind: "manual"|"auto"): Promise<boolean>`, `translateMissing(): Promise<boolean>`, `savePdf(): Promise<void>`, `openHistory(): void`.

- [ ] **Step 1: Remove:** `LS_DATA`/`LS_KEY`, `loadLocal/saveLocal/getKey/setKey`, `gemini`, `googleTranslate`, `googleEntry`, `noDiacritics` (if unused), backup export/import + `#backupIn`, `welcome()`, the key section and "CV gol" section of Settings, the `#key=` handler. `translateEntry`/`translatePersonal` now call `api.translate` with the Task 7 payloads (`section` = kind, `current` = `e.current`). `errMsg` maps `offline`, `limit` ("Ai tradus foarte mult azi. Încearcă mâine."), else generic.
- [ ] **Step 2: State and saving:** start = `purgeLegacy()` → `await startGate()` → `state = normalize(cv || EMPTY())`, `currentVersionId = versionId`. `commit()` marks dirty and (re)starts a 10 s timer → `saveNow("auto")`. Top bar gets "💾 Salvează": `translateMissing()` (best effort) → `saveNow("manual")` → if translations complete, `savePdf()`; else show "CV-ul e salvat. PDF-ul nu s-a putut face acum." + "Încearcă din nou". `saveNow` sends `basedOn=currentVersionId`; on `latest:false` → `state = normalize(current.data)`, `currentVersionId = current.id`, modal "CV-ul a fost schimbat pe celălalt dispozitiv. Ți-am arătat ultima variantă." Undo stack is cleared then. On `offline` keep dirty, toast "Nu ai internet. CV-ul nu s-a salvat încă." Auto-save errors never show modals, only a small status line in the top bar ("Salvat ✓ 14:32" / "Nesalvat").
- [ ] **Step 3: PDF:** `savePdf()` builds the blob with existing `buildPDF()`. Android/other → existing `saveBlob`. iOS → never call `navigator.share` after an `await`; instead show a modal with the drawn "Salvează în Fișiere" picture and a big "📄 Salvează PDF-ul" button whose click handler calls `navigator.share({files:[new File([blob], name, {type:"application/pdf"})]})`; if `navigator.canShare?.({files})` is false, fall back to `saveBlob`. `download()` buttons reuse `savePdf()`.
- [ ] **Step 4: History:** Settings becomes "🕘 Versiuni anterioare" and "🚪 Ieșire" (logout + reload). `openHistory()` lists versions (date "15 noiembrie 2026, 14:32", device label, "(acum)" on latest); tap → preview rendered with the existing preview renderer from a temporary state → "Revino la versiunea aceasta" → `api.restoreVersion(id, currentVersionId)` → load result.
- [ ] **Step 5: Verify in the browser pane** against `wrangler dev`: edit a job → status shows "Salvat ✓" within ~10 s; "Salvează" translates and downloads `CV_<Nume>_EN.pdf`; stop `wrangler dev`, press "Salvează" → offline message, edits still visible; restart, press again → saved; open a second tab (second paired device in another browser profile), save from tab A, then edit in tab B → conflict modal and tab B shows A's content; history lists versions and restore works; set session `last_used` back 31 min in local D1 → next save asks for PIN only and then completes with edits intact; `localStorage` has only `cv-device-id`; old `cv-editor-*` keys planted beforehand are gone.
- [ ] **Step 6: Commit** `feat(client): server-backed editor with history and PDF`

### Task 12: Deploy and go live

**Files:**
- Modify: `worker/wrangler.toml` (`database_id`), `api.js` (`API_BASE`), `index.html` (CSP `connect-src`), `worker/.cv-api-url` (gitignored)

- [ ] **Step 1 (owner, in a terminal in `worker/`):** `npx wrangler login`. Then Claude runs `npx wrangler d1 create cv`, fills `database_id`, `npx wrangler d1 migrations apply cv --remote`.
- [ ] **Step 2 (secrets):** Claude runs `node admin.mjs init-token` and `node admin.mjs init-data-key`. The owner types `npx wrangler secret put GEMINI_KEY` and `npx wrangler secret put CONTACT_TEXT` himself. Owner restricts the Gemini key in Google Cloud to "Generative Language API".
- [ ] **Step 3:** `npx wrangler deploy`; record the `https://cv-api.<sub>.workers.dev` URL in `api.js`, CSP and `worker/.cv-api-url`; remove the localhost `connect-src` entry from the CSP but keep `API_BASE`'s localhost branch.
- [ ] **Step 4: Verify the Worker:** `curl -i -H "Origin: https://evil.example" <url>/cv` → 403; `curl -i -H "Origin: https://m1hu0.github.io" <url>/cv` → 401 `session`; `node admin.mjs devices` → `[]`.
- [ ] **Step 5 (owner):** `node admin.mjs set-pin`. Owner hands over the current CV file; Claude runs `node admin.mjs import <path outside repo>`; `node admin.mjs versions` shows 1 version.
- [ ] **Step 6:** Confirm `git status` / `git diff --cached` contain no secrets or CV data, run all tests (`npm test` in `worker/`, `node --test test/`), then **ask the owner** before `git push` (this changes the live site). Push; wait for Pages build; `curl -s https://m1hu0.github.io/cv/ | grep Content-Security-Policy`.
- [ ] **Step 7 (owner + father):** `node admin.mjs pair "Telefon tata"` → owner sends the link; father follows the screens; owner `approve`s; repeat for the tablet. On the iPhone/iPad check Review Focus 4 (PDF saves to Files) and that the app still opens after closing it.
- [ ] **Step 8: Commit** `chore: deploy configuration`
