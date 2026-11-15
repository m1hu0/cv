import { json } from "./index.js";
import { sha256hex, verifyPin, verifySignature, randomToken } from "./crypto.js";
import { getSetting, setSetting, audit, now } from "./db.js";

const GLOBAL_FAIL_LIMIT = 20;
const GLOBAL_WINDOW_MS = 24 * 3600 * 1000;
const PAIR_MAX_PIN_FAILS = 3;
const NONCE_TTL_MS = 60 * 1000;
const LOCK_BASE_MS = 15 * 60 * 1000;
const WINDOW_FAIL_LIMIT = 5;
const TOTAL_FAIL_LIMIT = 10;
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_MAX_MS = 8 * 3600 * 1000;
const MAX_STR = 2048;

export async function isGlobalLocked(env) {
  return (await getSetting(env, "global_lock")) !== null;
}

// Records a wrong PIN (deviceId may be null while pairing) and audits it.
// Returns true when the global lock is set as a result.
export async function recordPinFailure(env, deviceId) {
  const t = now();
  await env.DB.prepare("INSERT INTO pin_failures (device_id, at) VALUES (?, ?)").bind(deviceId ?? null, t).run();
  await audit(env, "pin_fail", deviceId ?? null, false);
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM pin_failures WHERE at > ?").bind(t - GLOBAL_WINDOW_MS).first();
  if (row.c >= GLOBAL_FAIL_LIMIT) {
    await setSetting(env, "global_lock", "1");
    return true;
  }
  return isGlobalLocked(env);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function cleanKey(k) {
  if (!isObj(k) || k.d !== undefined) return null;
  if (k.kty !== "EC" || k.crv !== "P-256") return null;
  if (typeof k.x !== "string" || typeof k.y !== "string" || !k.x || !k.y) return null;
  return { kty: "EC", crv: "P-256", x: k.x, y: k.y };
}

const str = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_STR;
const contactOf = (env) => (typeof env.CONTACT_TEXT === "string" && env.CONTACT_TEXT ? { contact: env.CONTACT_TEXT } : {});
const unauthorized = () => json(401, { error: "session" });

// Resolves the bearer token to { deviceId, label }, or returns a 401 Response.
export async function requireSession(req, env) {
  const header = req.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token.length > MAX_STR) return unauthorized();
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.created_at, s.last_used, d.id AS device_id, d.label, d.status
     FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.token_hash = ?`,
  ).bind(hash).first();
  if (!row) return unauthorized();
  const t = now();
  if (t - row.last_used > SESSION_IDLE_MS || t - row.created_at > SESSION_MAX_MS) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(hash).run();
    return unauthorized();
  }
  if (row.status !== "active") return unauthorized();
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET last_used = ? WHERE token_hash = ?").bind(t, hash),
    env.DB.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").bind(t, row.device_id),
  ]);
  return { deviceId: row.device_id, label: row.label };
}

const badCode = () => json(400, { error: "bad_code" });
const locked = () => json(423, { error: "global_lock" });

export const routes = {
  "POST /pair": async (req, env, { body }) => {
    if (await isGlobalLocked(env)) return locked();
    const b = isObj(body) ? body : {};
    const key = cleanKey(b.publicKey);
    if (!key) return json(400, { error: "bad_key" });
    if (typeof b.code !== "string" || !b.code) return badCode();

    const codeHash = await sha256hex(b.code);
    const pinHash = await getSetting(env, "pin_hash");
    const pinSalt = await getSetting(env, "pin_salt");
    const open = await env.DB.prepare(
      "SELECT 1 AS x FROM pairing_codes WHERE code_hash = ? AND used = 0 AND expires_at > ? AND pin_fails < ?",
    ).bind(codeHash, now(), PAIR_MAX_PIN_FAILS).first();
    if (!open) return badCode();
    if (!pinHash || !pinSalt) return json(503, { error: "not_configured" });

    // Reserve the attempt atomically before verifying, so parallel requests
    // cannot test more than PAIR_MAX_PIN_FAILS PINs per code.
    const row = await env.DB.prepare(
      `UPDATE pairing_codes SET pin_fails = pin_fails + 1
       WHERE code_hash = ? AND used = 0 AND expires_at > ? AND pin_fails < ?
       RETURNING label, pin_fails`,
    ).bind(codeHash, now(), PAIR_MAX_PIN_FAILS).first();
    if (!row) return badCode();

    const pinOk = typeof b.pin === "string" && b.pin.length > 0 && (await verifyPin(b.pin, pinHash, pinSalt));
    if (!pinOk) {
      if (row.pin_fails >= PAIR_MAX_PIN_FAILS)
        await env.DB.prepare("UPDATE pairing_codes SET used = 1 WHERE code_hash = ?").bind(codeHash).run();
      const globallyLocked = await recordPinFailure(env, null);
      if (globallyLocked) return locked();
      return json(403, { error: "bad_pin", left: Math.max(0, PAIR_MAX_PIN_FAILS - row.pin_fails) });
    }

    const deviceId = randomToken(16);
    const t = now();
    // One transaction; the insert only happens while the code is still open,
    // so two simultaneous requests cannot both pair with it.
    const [ins] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO devices (id, label, public_jwk, status, created_at, last_seen)
         SELECT ?, ?, ?, 'pending', ?, ?
         WHERE EXISTS (SELECT 1 FROM pairing_codes WHERE code_hash = ? AND used = 0 AND expires_at > ?)`,
      ).bind(deviceId, row.label, JSON.stringify(key), t, t, codeHash, t),
      env.DB.prepare("UPDATE pairing_codes SET used = 1 WHERE code_hash = ?").bind(codeHash),
    ]);
    if (!ins.meta.changes) return badCode();
    await audit(env, "pair", deviceId, true);
    return json(200, { deviceId, status: "pending", contact: env.CONTACT_TEXT });
  },

  "POST /challenge": async (req, env, { body }) => {
    const id = isObj(body) ? body.deviceId : undefined;
    const d = str(id) ? await env.DB.prepare("SELECT status FROM devices WHERE id = ?").bind(id).first() : null;
    if (!d || d.status === "revoked") return json(404, { error: "unknown_device" });
    const t = now();
    const nonce = randomToken(32);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(t),
      env.DB.prepare("INSERT INTO challenges (nonce, device_id, expires_at) VALUES (?, ?, ?)").bind(nonce, id, t + NONCE_TTL_MS),
    ]);
    return json(200, { nonce });
  },

  "POST /login": async (req, env, { body }) => {
    const b = isObj(body) ? body : {};
    if (!str(b.deviceId) || !str(b.nonce) || !str(b.signature) || typeof b.pin !== "string" || b.pin.length > MAX_STR)
      return json(400, { error: "bad_request" });
    const id = b.deviceId;

    // Single-use nonce: consumed atomically, so it cannot be replayed concurrently.
    const used = await env.DB.prepare(
      "DELETE FROM challenges WHERE nonce = ? AND device_id = ? AND expires_at > ? RETURNING nonce",
    ).bind(b.nonce, id, now()).first();
    if (!used) return json(401, { error: "bad_nonce" });

    const d = await env.DB.prepare("SELECT id, label, public_jwk, status, locked_until FROM devices WHERE id = ?").bind(id).first();
    if (!d || d.status === "revoked") return json(404, { error: "unknown_device" });

    let jwk;
    try { jwk = JSON.parse(d.public_jwk); } catch { jwk = null; }
    if (!jwk || !(await verifySignature(jwk, b.nonce, b.signature))) {
      await audit(env, "login", id, false);
      return json(401, { error: "bad_signature" });
    }

    const contact = contactOf(env);
    if (await isGlobalLocked(env)) return json(423, { error: "global_lock", ...contact });
    if (d.status === "pending") return json(403, { error: "pending", ...contact });
    const lockedResponse = (row) =>
      json(423, { error: "locked", ...(row.status === "active" && row.locked_until > now() ? { until: row.locked_until } : {}), ...contact });
    if (d.status === "locked" || d.locked_until > now()) return lockedResponse(d);

    // Reserve the attempt atomically BEFORE checking the PIN: parallel requests
    // cannot test more PINs than the limits allow.
    const r = await env.DB.prepare(
      `UPDATE devices SET fails_window = fails_window + 1, fails_since_success = fails_since_success + 1
       WHERE id = ? AND status = 'active' AND locked_until <= ? AND fails_window < ? AND fails_since_success < ?
       RETURNING fails_window, fails_since_success, lock_level`,
    ).bind(id, now(), WINDOW_FAIL_LIMIT, TOTAL_FAIL_LIMIT).first();
    if (!r) {
      const cur = await env.DB.prepare("SELECT status, locked_until FROM devices WHERE id = ?").bind(id).first();
      return lockedResponse(cur || { status: "locked", locked_until: 0 });
    }

    const pinHash = await getSetting(env, "pin_hash");
    const pinSalt = await getSetting(env, "pin_salt");
    if (!pinHash || !pinSalt) {
      // Not the user's fault: give the attempt back.
      await env.DB.prepare(
        "UPDATE devices SET fails_window = MAX(fails_window - 1, 0), fails_since_success = MAX(fails_since_success - 1, 0) WHERE id = ?",
      ).bind(id).run();
      return json(503, { error: "not_configured" });
    }

    if (await verifyPin(b.pin, pinHash, pinSalt)) {
      const t = now();
      const ok = await env.DB.prepare(
        `UPDATE devices SET fails_window = 0, fails_since_success = 0, lock_level = 0, last_seen = ?
         WHERE id = ? AND status = 'active' RETURNING id`,
      ).bind(t, id).first();
      if (!ok) return lockedResponse({ status: "locked", locked_until: 0 });
      const token = randomToken(32);
      await env.DB.prepare("INSERT INTO sessions (token_hash, device_id, created_at, last_used) VALUES (?, ?, ?, ?)")
        .bind(await sha256hex(token), id, t, t).run();
      await audit(env, "login", id, true);
      return json(200, { session: token });
    }

    // Wrong PIN: lock transitions come from the values this request reserved.
    const globallyLocked = await recordPinFailure(env, id);
    await audit(env, "login", id, false);
    if (r.fails_window >= WINDOW_FAIL_LIMIT || r.fails_since_success >= TOTAL_FAIL_LIMIT) {
      const until = now() + LOCK_BASE_MS * 2 ** r.lock_level;
      await env.DB.prepare(
        `UPDATE devices SET locked_until = ?, lock_level = lock_level + 1, fails_window = 0,
         status = CASE WHEN ? THEN 'locked' ELSE status END WHERE id = ? AND status IN ('active', 'locked')`,
      ).bind(until, r.fails_since_success >= TOTAL_FAIL_LIMIT ? 1 : 0, id).run();
      await audit(env, "lock", id, false);
    }
    if (globallyLocked) return json(423, { error: "global_lock", ...contact });
    return json(403, { error: "bad_pin", left: Math.max(0, WINDOW_FAIL_LIMIT - r.fails_window) });
  },

  "POST /logout": async (req, env) => {
    const header = req.headers.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token && token.length <= MAX_STR)
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
    return json(200, { ok: true });
  },
};
