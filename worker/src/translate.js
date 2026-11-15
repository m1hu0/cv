import { json } from "./index.js";
import { requireSession } from "./auth.js";
import { audit } from "./db.js";

const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
const DAILY_LIMIT = 300;
const MAX_INPUT_BYTES = 8192;
const MAX_LINES = 50;
const GEMINI_TIMEOUT_MS = 20000;

const ENTRY_KEYS = ["role", "employer", "place", "subtitle", "lines"];
const PERSONAL_KEYS = ["name", "birth", "nationality", "phone", "email", "address"];

// Prompt text copied verbatim from the client (app.js).
const RULES = `You translate a Romanian CV entry into polished, professional English for a Europass CV.
Return ONLY a JSON object with exactly these keys: role, employer, place, subtitle, lines (array of strings).
Rules:
- "lines" must have the same number of items, in the same order, as the input lines. Never merge, split, drop or add lines.
- Fix spelling and grammar; never invent facts, numbers or details that are not in the input.
- Use correct technical terminology for electrical, security-systems and construction work (e.g. "tablou electric" = "electrical panel", "împământare" = "grounding", "punere în funcțiune" = "commissioning", "TVCI" = "CCTV").
- Use American spelling (center, organized, labeling). Keep numbers, units (mm², VAC, sqm), model names and acronyms as written.
- role: the job title or qualification in Title Case (e.g. "Security Systems Technician").
- employer: keep company names exactly as written (e.g. "SC Exemplu SRL", "Alfa Construct"); translate only generic names of schools or public institutions (e.g. "Colegiul Tehnic Exemplu" -> "Technical College Exemplu").
- place: city names without Romanian diacritics and the country in English (e.g. "Brașov, România" -> "Brasov, Romania").
- subtitle: short heading in Title Case, or "" if empty.
- Any empty input field -> "".`;

function styleRule(section, current) {
  if (section === "education") return "This is an EDUCATION / TRAINING entry: each line is a skill or module learned, written as a short noun phrase without a final period (e.g. \"Installation of CCTV systems\").";
  if (current) return "This is the CURRENT job: write each line as a full sentence ending with a period, starting with a noun phrase or present-tense verb (e.g. \"Execution of …\", \"Performing …\").";
  return "This is a PAST job: write each line as a full sentence ending with a period, starting with a past-tense action verb (e.g. \"Installed …\", \"Coordinated …\").";
}

const personalPrompt = (p) => `Translate these Romanian personal-details fields for an English Europass CV. Return ONLY JSON with keys name, birth, nationality, phone, email, address.
Keep name, birth date, phone and email exactly as written. nationality as an English adjective ("Română" -> "Romanian"). address in English, places without Romanian diacritics ("Strada Florilor 10, Pitești, România" -> "10 Strada Florilor, Pitesti, Romania"). Empty input -> "".
Input: ${JSON.stringify(p)}`;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const exactKeys = (o, keys) => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(o, x));
};
const allStrings = (o, keys) => keys.every((k) => typeof o[k] === "string");

// Returns the validated request or null.
function validate(body) {
  if (!isObj(body)) return null;
  const { kind, input } = body;
  if (!isObj(input) || new TextEncoder().encode(JSON.stringify(input)).byteLength > MAX_INPUT_BYTES) return null;
  if (kind === "entry") {
    if (!exactKeys(body, ["kind", "section", "current", "input"])) return null;
    if (body.section !== "work" && body.section !== "education") return null;
    if (typeof body.current !== "boolean") return null;
    if (!exactKeys(input, ENTRY_KEYS) || !allStrings(input, ENTRY_KEYS.slice(0, 4))) return null;
    if (!Array.isArray(input.lines) || input.lines.length > MAX_LINES || !input.lines.every((l) => typeof l === "string")) return null;
    return body;
  }
  if (kind === "personal") {
    if (!exactKeys(body, ["kind", "input"])) return null;
    if (!exactKeys(input, PERSONAL_KEYS) || !allStrings(input, PERSONAL_KEYS)) return null;
    return body;
  }
  return null;
}

// Atomic daily counter (UTC day). Increments first; false when over the limit.
async function takeSlot(env) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    "INSERT INTO translate_usage (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count",
  ).bind(day, DAILY_LIMIT).first();
  return row !== null;
}

// Returns { text } on success, or { fail: "server" | "unavailable" }.
async function callGemini(env, prompt) {
  for (const model of GEMINI_MODELS) {
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      });
    } catch {
      continue; // network error or timeout: try the next model
    }
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const text = (j?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("");
      return { text };
    }
    const msg = await res.json().then((b) => b?.error?.message || "", () => "");
    if (res.status === 403 || (res.status === 400 && /api key/i.test(msg))) return { fail: "server" };
    // 404 / 429 / anything else: try the next model
  }
  return { fail: "unavailable" };
}

function parseOutput(text, req) {
  let out;
  try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; }
  if (!isObj(out)) return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  if (req.kind === "personal") return Object.fromEntries(PERSONAL_KEYS.map((k) => [k, str(out[k])]));
  if (!Array.isArray(out.lines) || out.lines.length !== req.input.lines.length) return null;
  return {
    role: str(out.role), employer: str(out.employer), place: str(out.place), subtitle: str(out.subtitle),
    lines: out.lines.map(str),
  };
}

const session = (fn) => async (req, env, ctx) => {
  const s = await requireSession(req, env);
  return s instanceof Response ? s : fn(req, env, ctx, s);
};

export const routes = {
  "POST /translate": session(async (req, env, { body }, s) => {
    const r = validate(body);
    if (!r) return json(400, { error: "bad_input" });
    if (typeof env.GEMINI_KEY !== "string" || !env.GEMINI_KEY) return json(500, { error: "server" });
    if (!(await takeSlot(env))) return json(429, { error: "limit" });

    const prompt = r.kind === "personal"
      ? personalPrompt(r.input)
      : RULES + "\n" + styleRule(r.section, r.current) + "\n\nInput (Romanian):\n" + JSON.stringify(r.input, null, 1);
    const g = await callGemini(env, prompt);
    if (g.fail) {
      await audit(env, "translate", s.deviceId, false);
      return g.fail === "server" ? json(500, { error: "server" }) : json(503, { error: "unavailable" });
    }
    const out = parseOutput(g.text, r);
    await audit(env, "translate", s.deviceId, out !== null);
    return out ? json(200, out) : json(502, { error: "bad_output" });
  }),
};
