import { env, exports } from "cloudflare:workers";
import { sha256hex } from "../src/crypto.js";

export const ADMIN = { Authorization: "Bearer " + "test-admin-token-0123456789abcdef0123456789" };

export const call = (path, init = {}) => exports.default.fetch(new Request("http://x" + path, init));

// Active device + a valid session; returns authed request helpers.
export async function makeSession(deviceId = "d1", label = "Telefon") {
  await env.DB.prepare("INSERT OR REPLACE INTO devices (id,label,public_jwk,status,created_at,last_seen) VALUES (?,?,?,?,?,?)")
    .bind(deviceId, label, "{}", "active", Date.now(), Date.now()).run();
  const token = "tok-" + deviceId + "-" + crypto.randomUUID();
  await env.DB.prepare("INSERT INTO sessions (token_hash,device_id,created_at,last_used) VALUES (?,?,?,?)")
    .bind(await sha256hex(token), deviceId, Date.now(), Date.now()).run();
  const h = { Authorization: "Bearer " + token };
  return {
    token,
    get: (p) => call(p, { headers: h }),
    post: (p, body) => call(p, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

export async function resetDb() {
  for (const t of ["settings", "devices", "pairing_codes", "challenges", "sessions", "pin_failures", "versions", "audit"])
    await env.DB.prepare(`DELETE FROM ${t}`).run();
}
