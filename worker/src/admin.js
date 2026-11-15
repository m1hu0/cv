import { json } from "./index.js";
import { safeEqual, randomToken, sha256hex, hashPin } from "./crypto.js";
import { setSetting, audit, now } from "./db.js";
import { importVersion, listVersions, versionPayload, validCv, isObj, notFound } from "./cv.js";

const PAIR_LINK_PREFIX = "https://m1hu0.github.io/cv/#pair=";
const PAIR_TTL_MS = 24 * 3600 * 1000;
const AUTH_WINDOW_MS = 3600 * 1000;
const AUTH_MAX_FAILS = 10;
const MAX_DEVICES = 3;
const MIN_TOKEN_LEN = 32;

// Returns a Response when the call must be refused, otherwise null.
async function guard(req, env) {
  const ip = await sha256hex(req.headers.get("cf-connecting-ip") || "unknown");
  const since = now() - AUTH_WINDOW_MS;
  const row = await env.DB.prepare("SELECT COUNT(*) AS c FROM audit WHERE event = 'admin_auth' AND ok = 0 AND ip = ? AND at > ?")
    .bind(ip, since).first();
  if (row.c >= AUTH_MAX_FAILS) return json(429, { error: "rate_limited" });
  const header = req.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = env.ADMIN_TOKEN;
  // Fail closed: an unset or short secret never authenticates anyone.
  const valid = typeof secret === "string" && secret.length >= MIN_TOKEN_LEN && token.length > 0 && safeEqual(token, secret);
  if (!valid) {
    await env.DB.prepare("INSERT INTO audit (at, event, device_id, ok, ip) VALUES (?, 'admin_auth', NULL, 0, ?)")
      .bind(now(), ip).run();
    return json(401, { error: "unauthorized" });
  }
  return null;
}

const admin = (fn) => async (req, env, ctx) => (await guard(req, env)) || fn(req, env, ctx);

const ok = () => json(200, { ok: true });

async function getDevice(env, id) {
  return env.DB.prepare("SELECT id, status FROM devices WHERE id = ?").bind(id).first();
}

export const routes = {
  "POST /admin/pin": admin(async (req, env, { body }) => {
    const pin = body && typeof body === "object" ? body.pin : undefined;
    if (typeof pin !== "string" || !/^\d{6,}$/.test(pin)) return json(400, { error: "weak_pin" });
    const { hash, salt } = await hashPin(pin);
    await setSetting(env, "pin_hash", hash);
    await setSetting(env, "pin_salt", salt);
    return ok();
  }),

  "POST /admin/pair": admin(async (req, env, { body }) => {
    const label = body && typeof body === "object" && body.label !== undefined ? body.label : "";
    if (typeof label !== "string" || label.length > 100) return json(400, { error: "bad_label" });
    const code = randomToken(16);
    const expiresAt = now() + PAIR_TTL_MS;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM pairing_codes WHERE used = 0"),
      env.DB.prepare("INSERT INTO pairing_codes (code_hash, label, expires_at, used, pin_fails) VALUES (?, ?, ?, 0, 0)")
        .bind(await sha256hex(code), label, expiresAt),
    ]);
    return json(200, { code, link: PAIR_LINK_PREFIX + code, expiresAt });
  }),

  "GET /admin/devices": admin(async (req, env) => {
    const { results } = await env.DB.prepare(
      "SELECT id, label, status, created_at, last_seen, locked_until FROM devices ORDER BY created_at, id",
    ).all();
    return json(200, results.map((d) => ({
      id: d.id, label: d.label, status: d.status,
      createdAt: d.created_at, lastSeen: d.last_seen, lockedUntil: d.locked_until,
    })));
  }),

  "POST /admin/devices/:id/approve": admin(async (req, env, { params }) => {
    const d = await getDevice(env, params.id);
    if (!d) return json(404, { error: "not_found" });
    if (d.status === "revoked") return json(409, { error: "revoked" });
    if (d.status === "pending") {
      // Conditional update keeps the limit race-safe.
      const r = await env.DB.prepare(
        `UPDATE devices SET status = 'active'
         WHERE id = ? AND status = 'pending'
         AND (SELECT COUNT(*) FROM devices WHERE status IN ('active','locked')) < ?`,
      ).bind(d.id, MAX_DEVICES).run();
      if (!r.meta.changes) return json(409, { error: "too_many_devices" });
    }
    return ok();
  }),

  "POST /admin/devices/:id/revoke": admin(async (req, env, { params }) => {
    const d = await getDevice(env, params.id);
    if (!d) return json(404, { error: "not_found" });
    await env.DB.batch([
      env.DB.prepare("UPDATE devices SET status = 'revoked' WHERE id = ?").bind(d.id),
      env.DB.prepare("DELETE FROM sessions WHERE device_id = ?").bind(d.id),
      env.DB.prepare("DELETE FROM challenges WHERE device_id = ?").bind(d.id),
    ]);
    return ok();
  }),

  "POST /admin/devices/:id/unlock": admin(async (req, env, { params }) => {
    const d = await getDevice(env, params.id);
    if (!d) return json(404, { error: "not_found" });
    if (d.status === "revoked" || d.status === "pending") return json(409, { error: d.status });
    await env.DB.prepare(
      "UPDATE devices SET status = 'active', fails_window = 0, fails_since_success = 0, lock_level = 0, locked_until = 0 WHERE id = ?",
    ).bind(d.id).run();
    return ok();
  }),

  "POST /admin/unlock-all": admin(async (req, env) => {
    await setSetting(env, "global_lock", null);
    await env.DB.prepare("DELETE FROM pin_failures").run();
    return ok();
  }),

  "GET /admin/audit": admin(async (req, env) => {
    const raw = Number(new URL(req.url).searchParams.get("limit"));
    const limit = Number.isInteger(raw) && raw > 0 ? Math.min(raw, 1000) : 200;
    const { results } = await env.DB.prepare("SELECT id, at, event, device_id, ok FROM audit ORDER BY id DESC LIMIT ?")
      .bind(limit).all();
    return json(200, results.map((a) => ({ id: a.id, at: a.at, event: a.event, deviceId: a.device_id, ok: a.ok === 1 })));
  }),

  "POST /admin/import": admin(async (req, env, { body }) => {
    const data = isObj(body) ? body.data : undefined;
    if (!validCv(data)) return json(400, { error: "bad_cv" });
    const id = await importVersion(env, data);
    await audit(env, "import", null, true);
    return json(200, { id, latest: true });
  }),

  "GET /admin/versions": admin(async (req, env) => json(200, await listVersions(env))),

  "GET /admin/versions/:id": admin(async (req, env, { params }) => {
    const v = await versionPayload(env, params.id);
    return v ? json(200, v) : notFound();
  }),
};
