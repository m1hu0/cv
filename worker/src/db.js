export const now = () => Date.now();

export async function getSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

export async function setSetting(env, key, value) {
  if (value === null || value === undefined) {
    await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
  } else {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, String(value)).run();
  }
}

// Device id + outcome only. Never codes, PINs, tokens or CV content.
export async function audit(env, event, deviceId, ok) {
  await env.DB.prepare("INSERT INTO audit (at, event, device_id, ok) VALUES (?, ?, ?, ?)")
    .bind(now(), event, deviceId ?? null, ok ? 1 : 0).run();
}
