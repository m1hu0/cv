import { routes as adminRoutes } from "./admin.js";
import { routes as authRoutes } from "./auth.js";
import { routes as cvRoutes } from "./cv.js";
import { routes as translateRoutes } from "./translate.js";

// Later tasks export `routes` ({ "POST /pair": handler }) and merge them here.
const routes = { ...adminRoutes, ...authRoutes, ...cvRoutes, ...translateRoutes };

const MAX_BODY = 1.5 * 1024 * 1024;

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

export function compile(table) {
  return Object.entries(table).map(([key, handler]) => {
    const [method, path] = key.split(" ");
    return { method, parts: path.split("/"), handler };
  });
}

const compiled = compile(routes);

export function matchRoute(compiled, method, pathname) {
  const segs = pathname.split("/");
  for (const r of compiled) {
    if (r.method !== method || r.parts.length !== segs.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < segs.length && ok; i++) {
      if (r.parts[i].startsWith(":")) {
        try { params[r.parts[i].slice(1)] = decodeURIComponent(segs[i]); } catch { return null; }
      }
      else if (r.parts[i] !== segs[i]) ok = false;
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return { body: undefined };
  const declared = Number(req.headers.get("content-length"));
  if (declared > MAX_BODY) return { error: json(413, { error: "too_big" }) };
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY) return { error: json(413, { error: "too_big" }) };
  if (buf.byteLength === 0) return { body: undefined };
  try {
    return { body: JSON.parse(new TextDecoder().decode(buf)) };
  } catch {
    return { error: json(400, { error: "bad_json" }) };
  }
}

function withCors(res, origin) {
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Vary", "Origin");
  }
  return res;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    if (origin && origin !== env.ALLOWED_ORIGIN) return json(403, { error: "origin" });
    try {
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin ?? "",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Max-Age": "600",
            "Cache-Control": "no-store",
            Vary: "Origin",
          },
        });
      }

      const { body, error } = await readBody(req);
      if (error) return withCors(error, origin);

      const url = new URL(req.url);
      const m = matchRoute(compiled, req.method, url.pathname);
      if (!m) return withCors(json(404, { error: "not_found" }), origin);

      const ctx = { body, params: m.params };
      const res = await m.handler(req, env, ctx);
      res.headers.set("Cache-Control", "no-store");
      return withCors(res, origin);
    } catch (e) {
      console.error("unhandled", e && e.name);
      return withCors(json(500, { error: "server" }), origin);
    }
  },
};
