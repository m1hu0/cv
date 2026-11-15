# CV editor: secure backend, device pairing + PIN, version history

Date: 2026-11-15 · Status: approved by owner 2026-11-15

## Intent

The CV editor (static site at https://m1hu0.github.io/cv/, repo `m1hu0/cv`, **public**)
is used by one person: the owner's father, a non-technical user, on his **phone and
tablet only**. He opens it whenever his CV needs a change, edits in Romanian, and the
English Europass version is produced by Gemini.

Today everything lives in the browser: the CV in `localStorage` (`app.js:73-77`), the
Gemini key in `localStorage` and in plain request URLs (`app.js:79-80`, `app.js:124`),
and a `#key=` link that injects the key (`app.js:871-873`). Anyone who finds the site
gets a working editor; anyone who gets the key can spend it.

We want:

1. Only his two devices can open the editor; a stranger who finds the URL gets nothing.
2. His current CV (the owner will supply it) lives server-side, and **every save is kept
   as a version** he (or the owner) can go back to.
3. Translation works without him ever handling a key, and the Gemini key never reaches
   any browser or the public repo.
4. Security as high as reasonably achievable for this scale.

## Goals

- Two-factor access: a registered device (something he has) + a PIN (something he knows).
- PIN brute force impossible in practice: server-enforced attempt limits.
- Gemini key stored only as a Cloudflare Worker secret.
- Full version history, server-side, never deleted automatically.
- For the father: open the home-screen icon → type PIN → edit. Nothing else.

## Non-goals

- Multiple users or accounts.
- Desktop/laptop use, sharing the editor with anyone else.
- Moving the static site off GitHub Pages or adding a custom domain.

## Anti-goals (failure even if it "works")

- Any secret (Gemini key, PIN, device tokens, admin token) or any personal CV data in
  the git repo or on GitHub Pages.
- The Worker usable as a general-purpose Gemini proxy by anyone holding a session.
- The father locked out with no simple recovery path for the owner.
- Extra steps for the father beyond "PIN".

## Constraints

- GitHub Pages is static and public: it can hold no secrets and cannot store writes.
- The repo is public: Worker source may live there, secrets may not.
- The site origin (`m1hu0.github.io`) and the Worker origin (`*.workers.dev`) differ, so
  cookies would be third-party and are blocked by Safari → auth must use headers, not cookies.
- **iOS/iPadOS Safari deletes script-written storage (localStorage, IndexedDB) after 7
  days without visiting the site**, unless the site is launched from a Home Screen icon.
  The father may go months between edits, so on Apple devices the editor **must be
  installed to the Home Screen** during pairing (manifest + apple meta tags already exist).
  Android Chrome does not have this limit, but Home Screen install is still the standard setup.
- Owner has a Cloudflare account; Node/npm are installed locally; `wrangler` will be run via `npx`.
- The owner logs in to Cloudflare himself (`npx wrangler login`) and enters secrets himself
  (`npx wrangler secret put …`); secrets never pass through chat or files.

## Approaches considered

| Approach | Trade-off | Verdict |
|---|---|---|
| **A. Cloudflare Worker + D1 behind the existing static site** | Free tier; secrets as Worker secrets; strong consistency for attempt counters and versions; one small service to maintain | **Chosen** |
| B. No server: CV + key AES-encrypted with a password, ciphertext in the repo | Saving needs a GitHub write token in the browser (anyone could read it); Gemini key ends up in the browser after decrypt; ciphertext is public so offline brute force is unlimited | Rejected |
| C. Firebase / Supabase | Needs email-based accounts and an extra function for Gemini anyway; more moving parts, no security gain | Rejected |

Login, chosen by the owner: **device pairing + PIN** (over "PIN only", which lets anyone
on the internet try PINs).

Storage choice within A: **D1** (SQLite) rather than KV, because KV is eventually
consistent (attempt counters could be raced) and versions are naturally rows.

## Design

### Components

- **Static site** (GitHub Pages, unchanged URL): `index.html`, `app.js`, assets.
  Gains pairing, PIN, history screens; loses all key handling.
- **Worker** (`worker/` folder in the repo, deployed with wrangler to
  `cv-api.<account>.workers.dev`). Secrets: `GEMINI_KEY`, `DATA_KEY` (AES-256 for data at
  rest), `ADMIN_TOKEN`. Binding: D1 database `cv`.
- **Admin script** (`worker/admin.mjs`, run on the owner's PC with Node): calls the
  Worker's admin endpoints with `ADMIN_TOKEN` read from an environment variable (never
  saved to a file in the repo).

### Device pairing

1. Owner runs `admin.mjs pair "Telefon tata"` → Worker creates a one-time pairing code
   (128-bit random, stored hashed, expires in 24 hours, single use) and the script
   prints a link `https://m1hu0.github.io/cv/#pair=<code>` (and a QR in the terminal).
2. The link is opened on the father's phone (by him, from a message — see below). The page:
   - removes the code from the address bar immediately;
   - generates a **non-extractable ECDSA P-256 key pair** with WebCrypto and stores the
     private key in IndexedDB (cannot be copied off the device even by script on the page);
   - sends the public key + pairing code → Worker registers the device.
   - on iOS, shows a mandatory "Add to Home Screen" step with pictures, and refuses to
     continue the setup in a normal Safari tab (detect `navigator.standalone`). The pairing
     must therefore be completed **from the Home Screen app**: flow is open link → add to
     Home Screen → open icon → pairing completes there. (Builder: keep the code in
     sessionStorage only across this hop if needed, or have the owner re-open the link
     inside the installed app; pick the simpler working flow and test it on iOS.)
3. Repeat for the tablet. Max devices: 3. Owner can list and revoke devices.

**The owner is usually not with his father when pairing** (owner's answer): the link is
sent by message and the father completes it alone. Therefore:

- Pairing code expires after **24 hours**, single use, at most one open code at a time
  (creating a new one cancels the old one).
- **Pairing also requires the PIN.** 3 wrong PINs on a pairing code burn the code; these
  failures count toward the global lockout.
- **New devices start as "pending"** and can't log in until the owner runs
  `admin.mjs approve <device>` (after a quick phone call: "did you just set it up?").
  The page shows "Gata! Spune-i lui … că ai terminat." until approved. A leaked link plus
  a guessed PIN therefore still gets nothing. (Designer's call.)
- The code lives only in the URL fragment (`#pair=`), which is never sent to any server,
  so chat apps' link-preview bots cannot see or use it.
- Pairing screens are self-explanatory for an older, non-technical user: one step per
  screen, large text, screenshots of the iOS Share → "Adaugă pe ecranul principal" steps
  and the Android "Instalează aplicația" prompt; detect the platform and show only the
  relevant pictures.

### Login (every visit)

1. Page asks the Worker for a challenge (random nonce, 60 s TTL, single use).
2. Page signs `nonce` with the device key; sends `deviceId, signature, PIN`.
3. Worker checks, in order: device exists and not revoked/locked → signature valid →
   PIN matches (PBKDF2-SHA256, ≥100k iterations, per-install salt, constant-time compare).
4. On success: a session token (256-bit random, stored hashed) valid 30 min idle / 8 h max,
   kept in page memory only (re-login after closing the app is fine: it's just the PIN).
5. Requests without a valid device signature never reach PIN checking, so a stranger
   cannot even try a PIN.

### PIN and lockout

- PIN: 6 digits minimum (owner may choose longer). Set by owner via `admin.mjs set-pin`
  (prompted, not echoed). Father can't change it himself (keeps UI simple).
- Per device: 5 wrong PINs → locked 15 min; each further lock doubles; after 10 wrong PINs
  total since last success → device locked until the owner unlocks it (`admin.mjs unlock`).
- Global: 20 wrong PINs across all devices in 24 h → everything locked until owner unlocks.
- Father sees plain Romanian messages ("PIN greșit. Mai ai 3 încercări.", "Blocat. Sună-l pe …").
  The contact text is a Worker variable `CONTACT_TEXT` set by the owner (never in the repo),
  returned only to a device whose signature verified (designer's call).

### Data and versions

- `GET /cv` → latest version. `POST /cv` → appends a new version (never overwrites).
- Each version row: id, created_at, device label, size, encrypted JSON blob
  (AES-256-GCM with `DATA_KEY`, random IV). Plaintext CV never stored.
- Photo (base64 in `personal.photo`) can make versions large; the builder may store the
  photo separately (deduplicated by hash) if rows approach D1 limits.
- Saving: explicit "Salvează" plus auto-save after edits settle (debounced, e.g. 10 s), and
  only when content changed. Consecutive auto-saves within 10 minutes of each other may be
  collapsed into one version so the history stays readable (builder's call on exact rule).
- **PDF on the device after changes** (owner's requirement): when he presses "Salvează"
  and the save succeeds, the page translates anything not yet translated, then builds the
  English Europass PDF with the existing generator (`buildPDF`, `app.js:855-859`) and saves
  it to the device as `CV_<Nume>_EN.pdf`, with no extra tap where the platform allows it.
  - Android: downloads straight to Descărcări.
  - iOS/iPadOS (Home Screen app): Apple doesn't allow a silent save; the page opens the
    share sheet (`navigator.share` with the file) and shows one picture: "Apasă «Salvează
    în Fișiere»". If sharing isn't available, fall back to the existing download.
  - Silent auto-saves to the server do **not** produce a PDF (that would flood Descărcări);
    only the explicit "Salvează" does. The existing "⬇ Descarcă CV-ul (PDF)" buttons stay.
  - If translation fails (no internet, Gemini limit), the version is still saved on the
    server, and the page says the PDF wasn't made yet and offers "Încearcă din nou".
- History screen: list of versions (date/time, device), preview, "Revino la versiunea
  aceasta" = save that content as a new latest version (history is never rewritten).
- **No offline editing, no local CV cache** (designer's call): the CV is only in page
  memory while logged in. Opening without internet shows "Nu ai internet. Încearcă din nou."
  This keeps personal data off the devices and avoids a local PIN gate.
- **Conflicts between phone and tablet** (designer's call): `POST /cv` carries the version
  id it was based on. If a newer version exists, the server still stores the submitted
  content as its own version (nothing is lost) but does **not** make it latest; the page
  says "CV-ul a fost schimbat pe celălalt dispozitiv" and loads the latest. The owner can
  recover the other copy from history.
- Initial import: owner runs `admin.mjs import <file>` with the CV he has (backup `.json`
  from the editor; if it's a PDF/Word, the builder converts it to the editor's JSON shape
  first, on the owner's PC, and the file is not committed).

### Translation

- `POST /translate` with `{ kind: "entry"|"personal", style, input }` (structured fields
  only). The Worker builds the prompt itself from the fixed `RULES` / `styleRule` templates
  now in `app.js:96-115` (moved server-side), so a stolen session cannot run arbitrary prompts.
- Input size capped (e.g. 8 KB); 300 calls/day limit; same model fallback list as today.
- The "test key" button, key field, `#key=` link and the client-side Google Translate
  fallback are removed.
- Owner should also restrict the Gemini key in Google Cloud to the Generative Language API.

### Admin endpoints (owner only)

Authenticated by `Authorization: Bearer <ADMIN_TOKEN>` (≥256-bit, compared in constant
time), rate-limited, all under `/admin/`: create pairing code, list/revoke devices, unlock,
set PIN, import CV, list/export versions, and a read-only audit log (logins, failures, saves).

### Hardening

- CORS: only `https://m1hu0.github.io`; no credentials mode needed.
- Strict CSP on the page via `<meta>`: `default-src 'self'`, `connect-src` the Worker only,
  no inline script (move any inline handlers), `object-src 'none'`, `base-uri 'none'`.
  The vendored libs in `lib/` stay self-hosted (no CDNs).
- Every Worker response: `Cache-Control: no-store`, JSON only, no stack traces.
- Pairing code and admin token never logged; audit log stores device id + outcome only.
- `noindex` already set; keep it.
- `.gitignore` for `.dev.vars`, `*.json` backups outside `worker/` config, `.wrangler/`.

## Left to the builder

- Exact UI layout of the pairing, PIN and history screens, within the existing style
  (big buttons, 19 px text, Romanian copy for an older user).
- Worker framework (plain fetch handler is fine), D1 schema details, migrations.
- Auto-save collapse rule, photo deduplication, exact rate-limit numbers within the ranges above.
- The iOS install-then-pair hop mechanics (must be tested on a real iPhone/iPad by the owner).
