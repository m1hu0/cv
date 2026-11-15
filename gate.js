// Full-screen gate: pairing, install help, PIN, and the blocked/pending states.
// Renders into #gate and keeps the editor hidden (body.gated) until login + CV load.
import { pair, login, getCv, setAuthLostHandler } from "./api.js";
import { hasDeviceKey, forgetDevice, getDeviceId, platform, isStandalone } from "./device.js";

const CODE_RE = /^[A-Za-z0-9_-]{16,128}$/;
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
});

let knownContact = "";
let rememberedPin = null; // PIN typed on the pairing screen; memory only, for "Verifică din nou"

// ---------- tiny DOM helpers (all text via textContent) ----------
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k);
  return n;
}
const gateEl = () => document.getElementById("gate");
function show(...nodes) {
  const g = gateEl();
  g.hidden = false;
  document.body.classList.add("gated");
  g.replaceChildren(h("main", { class: "gate-card" }, nodes));
  const f = g.querySelector("[autofocus]");
  if (f) f.focus();
  window.scrollTo(0, 0);
}
export function hideGate() {
  gateEl().hidden = true;
  document.body.classList.remove("gated");
}
const title = (t) => h("h2", { tabindex: "-1" }, t);
const para = (t, cls) => h("p", { class: cls || "gate-p" }, t);
const err = (t) => h("div", { class: "err-box", role: "alert" }, t);
const ok = (t) => h("div", { class: "ok-box", role: "status" }, t);
const btn = (label, onclick, cls = "btn-blue", extra) =>
  h("button", { type: "button", class: "btn btn-big btn-block " + cls, onclick, ...extra }, label);
const pic = (src, alt) => h("img", { class: "howto", src, alt });
const sentence = (s) => (/[.!?]$/.test(s) ? s : s + ".");
const busy = (t = "Un moment…") => show(h("div", { class: "busy" }, h("div", { class: "spin" }), t));

function hhmm(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// ---------- screens ----------
function notConfigured() {
  show(
    title("Încă nu e gata"),
    para("Aplicația nu e configurată pe acest telefon. " + (knownContact ? sentence(knownContact) : "Cere linkul de configurare.")),
  );
}

// Every retry replaces the screen synchronously, so a double tap cannot fire twice.
const retryBtn = (retry, cls) => btn("Încearcă din nou", () => { busy(); retry(); }, cls);

function offlineScreen(retry) {
  show(title("Nu ai internet"), err("Nu ai internet. Încearcă din nou."), retryBtn(retry, "btn-green"));
}

function genericError(retry) {
  show(title("Ceva nu a mers"), err("Ceva nu a mers. Încearcă din nou."), retryBtn(retry, "btn-green"));
}

// Start-up failed after the gate (e.g. the editor could not start): reload is the only way on.
export function fatalError() {
  genericError(() => location.reload());
}

function blockedScreen(e, retry) {
  if (e.contact) knownContact = e.contact;
  const msg =
    e.code === "locked" && e.until
      ? "Prea multe încercări. Încearcă din nou la " + hhmm(e.until) + "."
      : "Aplicația e blocată. " + (e.contact ? sentence(e.contact) : "");
  show(title("Aplicația e blocată"), err(msg.trim()), retryBtn(retry, "btn-light"));
}

function pendingScreen(ctx, contact, note) {
  if (contact) knownContact = contact;
  const c = contact || knownContact;
  show(
    title("Gata!"),
    ok((c ? sentence(c) + " " : "") + "Spune-i că ai terminat."),
    note ? err(note) : null,
    btn("Verifică din nou", () => recheck(ctx), "btn-green"),
  );
}

async function recheck(ctx) {
  if (rememberedPin == null) return pinScreen(ctx);
  const pin = rememberedPin;
  busy();
  try {
    await login(pin);
    rememberedPin = null;
    await ctx.onLoggedIn();
  } catch (e) {
    if (e && e.code === "pending") return pendingScreen(ctx, e.contact, "Încă nu a fost aprobat. Mai așteaptă puțin.");
    handleError(e, ctx, () => recheck(ctx));
  }
}

function handleError(e, ctx, retry) {
  const code = e && e.code;
  if (e && e.contact) knownContact = e.contact;
  if (code === "offline" || code === "timeout") return offlineScreen(retry);
  if (code === "pending") return pendingScreen(ctx, e.contact);
  if (code === "locked" || code === "global_lock") return blockedScreen(e, () => pinScreen(ctx));
  if (code === "unknown_device" || code === "no_device" || code === "no_key" || code === "bad_signature") {
    forgetDevice().catch(() => {}).then(notConfigured);
    return;
  }
  genericError(retry);
}

// PIN entry. mode "login" or { pairCode } for the pairing PIN.
function pinScreen(ctx, message, pairCode) {
  const input = h("input", {
    id: "pin",
    class: "pin-input",
    type: "password",
    inputmode: "numeric",
    pattern: "[0-9]*",
    autocomplete: "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    maxlength: "32",
    "aria-label": "PIN",
    autofocus: true,
  });
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "");
  });
  const showBox = h("input", { type: "checkbox", id: "pinShow" });
  showBox.addEventListener("change", () => {
    input.type = showBox.checked ? "text" : "password";
  });
  const form = h(
    "form",
    { novalidate: true },
    h("label", { for: "pin", class: "lbl" }, pairCode ? "Scrie PIN-ul primit" : "Scrie PIN-ul"),
    input,
    h("label", { class: "check", for: "pinShow" }, showBox, "Arată PIN-ul"),
    message ? err(message) : null,
    h("button", { type: "submit", class: "btn btn-big btn-block btn-green gate-go" }, "Continuă"),
  );
  const attempt = async () => {
    const pin = input.value;
    if (pin.length < 6) {
      return pinScreen(ctx, "PIN-ul are cel puțin 6 cifre.", pairCode);
    }
    busy();
    if (pairCode) await doPair(ctx, pairCode, pin);
    else await doLogin(ctx, pin);
  };
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    attempt();
  });
  show(title(pairCode ? "Asociază telefonul" : "Intră în CV"), form);
}

async function doLogin(ctx, pin, retried) {
  try {
    await login(pin);
    await ctx.onLoggedIn();
  } catch (e) {
    if (e && e.code === "bad_pin") {
      // left 0 means this wrong PIN just locked the device; ask again (not counted) to learn until
      if (!e.left && !retried) return doLogin(ctx, pin, true);
      return pinScreen(ctx, "PIN greșit. Mai ai " + tries(e.left) + ".");
    }
    handleError(e, ctx, () => doLogin(ctx, pin));
  }
}

const tries = (n) => (n === 1 ? "1 încercare" : n + " încercări");

// The new key and device id are stored only when the server accepted them (see api.pair),
// so on any failure an already paired device keeps working with its old configuration.
async function doPair(ctx, code, pin) {
  try {
    const r = await pair(code, pin);
    lastPairContact = (r && r.contact) || "";
  } catch (e) {
    if (e && e.contact) knownContact = e.contact;
    if (e && e.code === "bad_pin") {
      if (!e.left) return pairDead("Codul nu mai este valabil după prea multe încercări.");
      return pinScreen(ctx, "PIN greșit. Mai ai " + tries(e.left) + ".", code);
    }
    if (e && e.code === "bad_code") return pairDead("Codul nu mai este valabil.");
    if (e && (e.code === "offline" || e.code === "timeout")) return offlineScreen(() => doPair(ctx, code, pin));
    if (e && (e.code === "global_lock" || e.code === "locked")) return blockedScreen(e, () => pinScreen(ctx, undefined, code));
    if (e && e.code === "not_configured") return pairDead("Serverul nu este gata încă.");
    return genericError(() => doPair(ctx, code, pin));
  }
  rememberedPin = pin;
  if (platform() !== "ios" && !isStandalone()) installScreen(() => pendingScreen(ctx, knownContactAfterPair()));
  else pendingScreen(ctx, knownContactAfterPair());
}
let lastPairContact = "";
const knownContactAfterPair = () => lastPairContact || knownContact;

function pairDead(why) {
  // Already paired before this link: the old setup still works (the address no longer has the code).
  const paired = !!getDeviceId();
  show(
    title("Nu merge cu acest link"),
    err(why),
    para("Cere un link nou. " + (knownContact ? sentence(knownContact) : "")),
    paired ? btn("Intră în CV ca până acum", () => { busy(); location.reload(); }, "btn-green") : null,
  );
}

function installScreen(next) {
  show(
    title("Pune iconița pe ecran"),
    para("Așa deschizi CV-ul mai ușor, ca pe orice altă aplicație."),
    pic("img/howto-android.svg", "Telefonul: meniul browserului cu opțiunea Instalează aplicația"),
    installPrompt
      ? btn(
          "Instalează aplicația",
          async () => {
            try {
              installPrompt.prompt();
              await installPrompt.userChoice;
            } catch {}
            installPrompt = null;
            next();
          },
          "btn-blue",
        )
      : null,
    btn("Mai departe", next, installPrompt ? "btn-light" : "btn-green"),
  );
}

// ---------- iOS: hop from Safari to the installed icon ----------
function iosHop(code) {
  const step = (n, t, body, ...rest) => [h("p", { class: "step" }, "Pasul " + n + " din 4"), title(t), body, ...rest];
  const s4 = () =>
    show(
      ...step(4, "Deschide iconița CV", para("Ieși din Safari și apasă iconița CV de pe ecranul telefonului."), pic("img/howto-ios-3.svg", "Ecranul principal cu iconița albastră CV")),
    );
  const s3 = () =>
    show(
      ...step(3, "Adaugă pe ecranul principal", para("Alege „Adaugă pe ecranul principal”, apoi apasă „Adaugă”."), pic("img/howto-ios-2.svg", "Lista cu opțiunea Adaugă pe ecranul principal"), btn("Am făcut asta", s4, "btn-green")),
    );
  const s2 = () =>
    show(
      ...step(2, "Apasă Partajează", para("Jos, în mijloc, e butonul pătrat cu săgeată în sus."), pic("img/howto-ios-1.svg", "Telefonul cu butonul Partajează evidențiat"), btn("Am apăsat", s3, "btn-green")),
    );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      s2();
    } catch {
      show(
        ...step(1, "Copiază codul", para("Nu am putut copia singur. Ține apăsat pe cod, alege „Selectează tot”, apoi „Copiază”."), h("input", { type: "text", readonly: true, value: code, class: "code-box", "aria-label": "Cod" })),
        btn("Am copiat", s2, "btn-green"),
      );
    }
  };
  show(...step(1, "Copiază codul", para("Apasă butonul. Codul se copiază singur."), btn("Copiază codul", copy, "btn-green")));
}

// ---------- installed iOS app without a key: paste the code ----------
function pasteScreen(ctx, message) {
  const parse = (t) => {
    t = String(t || "").trim();
    const m = t.match(/[#&?]pair=([A-Za-z0-9_-]+)/);
    return m ? m[1] : t;
  };
  const go = (raw) => {
    const code = parse(raw);
    if (!CODE_RE.test(code)) return pasteScreen(ctx, "Nu am găsit codul. Copiază-l din nou și încearcă.");
    pinScreen(ctx, undefined, code);
  };
  const field = h("input", { type: "text", id: "codeIn", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", "aria-label": "Codul primit" });
  show(
    title("Lipește codul"),
    para("Apasă butonul și, când apare „Lipește”, apasă pe el."),
    message ? err(message) : null,
    btn("Lipește codul primit", async () => {
      try {
        go(await navigator.clipboard.readText());
      } catch {
        pasteScreen(ctx, "Nu pot lipi singur. Scrie sau lipește codul în căsuța de jos.");
      }
    }, "btn-green"),
    h("label", { for: "codeIn", class: "lbl gate-or" }, "Sau lipește codul aici"),
    field,
    btn("Continuă", () => go(field.value), "btn-light"),
  );
}

// ---------- entry points ----------
function readPairCode() {
  const m = location.hash.match(/(?:^#|&)pair=([A-Za-z0-9_-]+)/);
  if (location.hash.includes("pair=")) history.replaceState(null, "", location.pathname + location.search);
  return m && CODE_RE.test(m[1]) ? m[1] : null;
}

// hasDeviceKey throws {code:"storage"} when storage cannot be read: startGate then shows a
// generic error with a reload button and the pairing is kept (never forgotten on an error).
async function configured() {
  if (!getDeviceId()) return false;
  if (await hasDeviceKey()) return true;
  await forgetDevice(); // the key is really gone (storage was wiped): start over
  return false;
}

export function startGate() {
  return new Promise((resolve) => {
    const ctx = {
      async onLoggedIn() {
        busy("Se încarcă CV-ul…");
        const load = async () => {
          try {
            const r = await getCv();
            resolve({
              cv: r && r.data ? r.data : null,
              versionId: r && r.id != null ? r.id : null,
              rev: r && r.id != null ? r.rev : null,
            });
          } catch (e) {
            if (e && (e.code === "offline" || e.code === "timeout")) return offlineScreen(load);
            handleError(e, ctx, load);
          }
        };
        await load();
      },
    };
    setAuthLostHandler(askPinAgain);
    (async () => {
      busy();
      const code = readPairCode();
      const isIos = platform() === "ios";
      if (code) {
        if (isIos && !isStandalone()) return iosHop(code);
        return pinScreen(ctx, undefined, code);
      }
      if (await configured()) return pinScreen(ctx);
      if (isIos && isStandalone()) return pasteScreen(ctx);
      notConfigured();
    })().catch(() => genericError(() => location.reload())); // e.g. {code:"storage"}: keep the pairing, offer a reload
  });
}

let reauth = null;
export function askPinAgain() {
  if (reauth) return reauth;
  reauth = new Promise((resolve) => {
    const ctx = {
      async onLoggedIn() {
        hideGate();
        reauth = null;
        resolve();
      },
    };
    pinScreen(ctx, "A trecut prea mult timp. Scrie PIN-ul din nou.");
  });
  return reauth;
}
