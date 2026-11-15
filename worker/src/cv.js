import { json } from "./index.js";
import { requireSession } from "./auth.js";
import { encryptJson, decryptJson } from "./crypto.js";
import { getSetting, audit, now } from "./db.js";

const LATEST_KEY = "latest_version_id";
const AUTO_WINDOW_MS = 10 * 60 * 1000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validCv = (d) => isObj(d) && isObj(d.personal) && Array.isArray(d.work);
// Base of a save: null ("no versions yet") or the {id, rev} the client's content came from.
const validBase = (b) =>
  b === null || (isObj(b) && Number.isSafeInteger(b.id) && b.id >= 0 && Number.isSafeInteger(b.rev) && b.rev >= 1);
const parseId = (s) => (/^\d{1,15}$/.test(s) ? Number(s) : null);
const toLatest = (v) => (v === null ? null : Number(v));

async function loadData(env, row) {
  return decryptJson(row.iv, row.blob, env.DATA_KEY);
}

async function getVersionRow(env, id) {
  return env.DB.prepare("SELECT * FROM versions WHERE id = ?").bind(id).first();
}

export async function latestPayload(env) {
  const latest = toLatest(await getSetting(env, LATEST_KEY));
  if (latest === null) return { id: null, data: null };
  const row = await getVersionRow(env, latest);
  if (!row) return { id: null, data: null };
  return { id: row.id, rev: row.rev, createdAt: row.created_at, updatedAt: row.updated_at, data: await loadData(env, row) };
}

async function insertRow(env, { data, kind, label, basedOn }) {
  const json_ = JSON.stringify(data);
  const { iv, blob } = await encryptJson(data, env.DATA_KEY);
  const t = now();
  const r = await env.DB.prepare(
    "INSERT INTO versions (created_at, updated_at, device_label, kind, based_on, size, iv, blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(t, t, label, kind, basedOn, new TextEncoder().encode(json_).byteLength, iv, blob).run();
  return r.meta.last_row_id;
}

// Atomically moves the latest pointer from base `from` ({id, rev} or null) to `to`; true if this call won.
// The rev check is in the same statement, so an in-place auto-save in between makes this fail.
async function claimLatest(env, from, to) {
  const r = from === null
    ? await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING").bind(LATEST_KEY, String(to)).run()
    : await env.DB.prepare(
        "UPDATE settings SET value = ? WHERE key = ? AND value = ? AND (SELECT rev FROM versions WHERE id = ?) = ?",
      ).bind(String(to), LATEST_KEY, String(from.id), from.id, from.rev).run();
  return r.meta.changes === 1;
}

async function stale(env, id) {
  return { id, rev: 1, latest: false, current: await latestPayload(env) };
}

const baseId = (b) => (b === null ? null : b.id);

// Saves a version. Shared by POST /cv and restore. Does not validate input.
export async function saveVersion(env, { data, basedOn, kind, label }) {
  const latest = toLatest(await getSetting(env, LATEST_KEY));
  const row = latest === null ? null : await getVersionRow(env, latest);
  const fresh = basedOn === null ? latest === null : !!row && basedOn.id === row.id && basedOn.rev === row.rev;
  if (!fresh) {
    return stale(env, await insertRow(env, { data, kind, label, basedOn: baseId(basedOn) }));
  }
  if (kind === "auto" && row) {
    const t = now();
    if (row.kind === "auto" && row.device_label === label && t - row.updated_at <= AUTO_WINDOW_MS) {
      const { iv, blob } = await encryptJson(data, env.DATA_KEY);
      const size = new TextEncoder().encode(JSON.stringify(data)).byteLength;
      // Only overwrite while the row is still the latest and still at the client's rev.
      const r = await env.DB.prepare(
        `UPDATE versions SET updated_at = ?, size = ?, iv = ?, blob = ?, rev = rev + 1
         WHERE id = ? AND rev = ? AND id = (SELECT CAST(value AS INTEGER) FROM settings WHERE key = ?)`,
      ).bind(t, size, iv, blob, row.id, basedOn.rev, LATEST_KEY).run();
      if (r.meta.changes === 1) return { id: row.id, rev: basedOn.rev + 1, latest: true };
    }
  }
  const id = await insertRow(env, { data, kind, label, basedOn: baseId(basedOn) });
  if (await claimLatest(env, basedOn, id)) return { id, rev: 1, latest: true };
  return stale(env, id);
}

// Admin import: always becomes latest.
export async function importVersion(env, data) {
  const id = await insertRow(env, { data, kind: "import", label: "admin", basedOn: null });
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(LATEST_KEY, String(id)).run();
  return id;
}

export async function listVersions(env) {
  const latest = toLatest(await getSetting(env, LATEST_KEY));
  const { results } = await env.DB.prepare(
    "SELECT id, created_at, updated_at, device_label, kind, size FROM versions ORDER BY id DESC",
  ).all();
  return results.map((v) => ({
    id: v.id, createdAt: v.created_at, updatedAt: v.updated_at,
    device: v.device_label, kind: v.kind, size: v.size, latest: v.id === latest,
  }));
}

export async function versionPayload(env, rawId) {
  const id = parseId(rawId);
  const row = id === null ? null : await getVersionRow(env, id);
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, data: await loadData(env, row) };
}

export const notFound = () => json(404, { error: "not_found" });

const session = (fn) => async (req, env, ctx) => {
  const s = await requireSession(req, env);
  return s instanceof Response ? s : fn(req, env, ctx, s);
};

export const routes = {
  "GET /cv": session(async (req, env) => json(200, await latestPayload(env))),

  "POST /cv": session(async (req, env, { body }, s) => {
    const b = isObj(body) ? body : {};
    if (!validCv(b.data) || !validBase(b.basedOn) || (b.kind !== "manual" && b.kind !== "auto")) {
      return json(400, { error: "bad_cv" });
    }
    const out = await saveVersion(env, { data: b.data, basedOn: b.basedOn, kind: b.kind, label: s.label });
    await audit(env, "save", s.deviceId, true);
    return json(200, out);
  }),

  "GET /versions": session(async (req, env) => json(200, await listVersions(env))),

  "GET /versions/:id": session(async (req, env, { params }) => {
    const v = await versionPayload(env, params.id);
    return v ? json(200, v) : notFound();
  }),

  "POST /versions/:id/restore": session(async (req, env, { params, body }, s) => {
    const id = parseId(params.id);
    const row = id === null ? null : await getVersionRow(env, id);
    if (!row) return notFound();
    const b = isObj(body) ? body : {};
    if (!validBase(b.basedOn)) return json(400, { error: "bad_cv" });
    const data = await loadData(env, row);
    const out = await saveVersion(env, { data, basedOn: b.basedOn, kind: "restore", label: s.label });
    await audit(env, "restore", s.deviceId, true);
    return json(200, out);
  }),
};

export { validCv, isObj };
