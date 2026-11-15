/* Editorul de CV — versiunea pentru telefon, cu CV-ul păstrat pe server.
   Modul ES: nu face nimic până la startApp() (apelat din main.js după PIN). */
import * as api from "./api.js";
import { platform } from "./device.js";
import { askPinAgain } from "./gate.js";

/* ================================================================ helpers */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const uid = () => Math.random().toString(36).slice(2, 9);
const LUNI = ["", "Ianuarie", "Februarie", "Martie", "Aprilie", "Mai", "Iunie", "Iulie", "August", "Septembrie", "Octombrie", "Noiembrie", "Decembrie"];
const THIS_YEAR = new Date().getFullYear();
const AUTO_SAVE_MS = 10000;
const RETRY_OFFLINE_MS = 30000;

const LANGS = {
  "Română": "Romanian", "Engleză": "English", "Franceză": "French", "Germană": "German", "Italiană": "Italian",
  "Spaniolă": "Spanish", "Portugheză": "Portuguese", "Norvegiană": "Norwegian", "Daneză": "Danish", "Suedeză": "Swedish",
  "Olandeză": "Dutch", "Rusă": "Russian", "Ucraineană": "Ukrainian", "Maghiară": "Hungarian", "Bulgară": "Bulgarian",
  "Sârbă": "Serbian", "Turcă": "Turkish", "Greacă": "Greek", "Polonă": "Polish", "Cehă": "Czech", "Arabă": "Arabic"
};
const LEVELS = [["A1", "începător"], ["A2", "elementar"], ["B1", "mediu"], ["B2", "mediu spre avansat"], ["C1", "avansat"], ["C2", "foarte avansat"]];
const LICENCES = ["AM", "A1", "A2", "A", "B1", "B", "BE", "C1", "C1E", "C", "CE", "D1", "D1E", "D", "DE", "Tr", "Tb", "Tv"];

const EMPTY = () => ({
  version: 1,
  personal: { ro: { name: "", birth: "", nationality: "Română", phone: "", email: "", address: "" }, en: null, photo: null },
  work: [], education: [],
  languages: { mother: "Română", foreign: [] },
  driving: []
});

let state = null;
let undoStack = [];
let tab = "work";
let previewTimer = null;

/* salvare pe server */
let currentVersionId = null;  // versiunea de pe server pe care se bazează ce e pe ecran
let currentRev = null;        // și revizia ei (crește la fiecare salvare automată peste aceeași versiune)
const currentBase = () => (currentVersionId == null ? null : { id: currentVersionId, rev: currentRev });
const isOffline = err => !!err && (err.code === "offline" || err.code === "timeout");
let dirty = false;            // sunt modificări nesalvate
let editSeq = 0;              // crește la fiecare modificare
let autoTimer = null;
let inflight = null;          // salvarea în curs (Promise)
let conflictEpoch = 0;        // crește când CV-ul a fost înlocuit cu varianta de pe celălalt dispozitiv

const sig = ro => JSON.stringify(ro);
const isTranslated = e => !!(e.en && e.sig === sig(e.ro));

function toast(msg, ms = 3500) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), ms);
}

/* ================================================================ dates */
const fmt = (m, y) => !y ? "" : (m ? String(m).padStart(2, "0") + "/" + y : String(y));
function dateText(e, lang) {
  const a = fmt(e.sm, e.sy);
  if (!a) return "";
  if (e.current) return a + " - " + (lang === "ro" ? "Prezent" : "Current");
  const b = fmt(e.em, e.ey);
  return (!b || b === a) ? a : a + " - " + b;
}
const startKey = e => (e.sy || 0) * 100 + (e.sm || 0);
const endKey = e => e.current ? 999999 : ((e.ey || e.sy || 0) * 100 + (e.em || 0));

/* ================================================================ data */
function normalize(d) {
  const base = EMPTY();
  d = Object.assign(base, d || {});
  d.personal = Object.assign(base.personal, d.personal || {});
  for (const list of [d.work, d.education]) for (const e of list) {
    if (!e.id) e.id = uid();
    if (e.en && e.sig === undefined) e.sig = sig(e.ro);
  }
  if (d.personal.en && d.personal.sig === undefined) d.personal.sig = sig(d.personal.ro);
  d.languages = d.languages || { mother: "Română", foreign: [] };
  d.driving = d.driving || [];
  return d;
}
function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 40) undoStack.shift();
  $("#undoBtn").disabled = false;
}
function commit() { markDirty(); render(); schedulePreview(); }
function undo() {
  if (!undoStack.length) return;
  state = normalize(JSON.parse(undoStack.pop()));
  $("#undoBtn").disabled = !undoStack.length;
  commit(); toast("Am anulat ultima modificare.");
}

/* ================================================================ saving */
const pad2 = n => String(n).padStart(2, "0");
const hhmm = d => pad2(d.getHours()) + ":" + pad2(d.getMinutes());

function setStatus(text) { const s = $("#saveStatus"); if (s) s.textContent = text; }

function markDirty() {
  dirty = true; editSeq++;
  if (!inflight) setStatus("Nesalvat");
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => { autoTimer = null; saveNow("auto"); }, AUTO_SAVE_MS);
}

const CONFLICT_TEXT = "CV-ul a fost schimbat pe celălalt dispozitiv. Ți-am arătat ultima variantă.";
const KEPT_TEXT = "Ce scriai acum nu s-a pierdut — e deschis mai jos.";
const entryCore = x => JSON.stringify([x.ro, x.sm || 0, x.sy || 0, x.em || 0, x.ey || 0, !!x.current]);

// Ce e scris acum și nu e încă în CV: fereastra de modificare deschisă. (Formularul cu date personale
// e mereu deja în CV, prin evenimentul „input”, deci îl acoperă reapplyEdits.)
function captureDrafts() {
  const d = {};
  if (editing && editing.pending) d.entry = { kind: editing.kind, isNew: editing.index < 0, e: clone($("#f-role") ? readEditor() : editing.draft) };
  return d;
}

// Modificările din `mine` față de `base` (pe intrări, limbi, permis, date personale) puse peste `target`.
// Ordinea mutată cu Sus/Jos nu se reface. Întoarce câte schimbări a pus.
function reapplyEdits(base, mine, target) {
  let n = 0;
  for (const kind of ["work", "education"]) {
    const baseById = new Map(base[kind].map(e => [e.id, e])), mineIds = new Set(mine[kind].map(e => e.id));
    for (const e of mine[kind]) {
      const b = baseById.get(e.id);
      if (b && JSON.stringify(b) === JSON.stringify(e)) continue;
      const i = target[kind].findIndex(x => x.id === e.id);
      if (i >= 0) target[kind][i] = clone(e); else target[kind].push(clone(e));
      n++;
    }
    for (const b of base[kind]) {
      if (mineIds.has(b.id)) continue;
      const i = target[kind].findIndex(x => x.id === b.id);
      if (i >= 0) { target[kind].splice(i, 1); n++; }
    }
  }
  for (const k of ["languages", "driving", "personal"]) {
    if (JSON.stringify(base[k]) !== JSON.stringify(mine[k])) { target[k] = clone(mine[k]); n++; }
  }
  return n;
}

// Redeschide fereastra de modificare cu ce scria, peste CV-ul nou. Întoarce true dacă textul diferă de CV.
function reopenEditor(d) {
  const idx = d.isNew ? -1 : state[d.kind].findIndex(x => x.id === d.e.id);
  const changed = idx < 0 || entryCore(state[d.kind][idx]) !== entryCore(d.e);
  openEditor(d.kind, idx);
  fillEditor(d.e);
  editing.draft = d.e;
  return changed;
}

// Pune pe ecran CV-ul de pe server (salvat între timp pe celălalt dispozitiv), fără să piardă ce se scria.
// opts.base/opts.mine: CV-ul trimis la salvarea respinsă și cel de acum, ca să se refacă ce s-a schimbat după.
// opts.silent: fără mesaj (încărcare la revenirea în aplicație, când nu era nimic nesalvat).
function loadLatest(cur, opts = {}) {
  const drafts = captureDrafts();
  const latest = normalize(cur && cur.data ? clone(cur.data) : EMPTY());
  let kept = opts.base && opts.mine ? reapplyEdits(opts.base, opts.mine, latest) : 0;
  state = latest;
  currentVersionId = cur && cur.id != null ? cur.id : null;
  currentRev = currentVersionId != null ? cur.rev : null;
  undoStack = []; $("#undoBtn").disabled = true;
  dirty = false; conflictEpoch++;
  clearTimeout(autoTimer); autoTimer = null;
  if (kept) { markDirty(); setStatus("Nesalvat"); } else setStatus("Salvat ✓ " + hhmm(new Date()));
  closeModal(); render(); schedulePreview();
  const entryKept = drafts.entry ? reopenEditor(drafts.entry) : false;
  if (opts.silent) return;
  const note = `<div class="ok-box" role="alert">${CONFLICT_TEXT}${kept || entryKept ? "<br>" + KEPT_TEXT : ""}</div>`;
  if (drafts.entry) { $("#modal").insertAdjacentHTML("afterbegin", note); $("#modalBack").scrollTop = 0; return; }
  showModal(`<h2>Atenție</h2>${note}
    <div class="modal-actions one"><button class="btn btn-green btn-big" id="mOk">Am înțeles</button></div>`);
  $("#mOk").onclick = closeModal;
}

// Înainte de lucru (revenire în aplicație, după PIN, după un minut fără atingeri): dacă pe server e
// o variantă mai nouă și aici nu e nimic nesalvat, o arată direct, fără mesaj.
let refreshing = false, lastActivity = 0;
const IDLE_MS = 60000;
const modalBlocks = () => $("#modalBack").classList.contains("show") && !(editing && editing.pending && $("#f-role"));
async function refreshIfStale() {
  if (refreshing || dirty || inflight || saveBusy || modalBlocks()) return;
  refreshing = true;
  try {
    const id0 = currentVersionId, rev0 = currentRev, seq0 = editSeq;
    const r = await api.getCv();
    if (currentVersionId !== id0 || currentRev !== rev0 || editSeq !== seq0) return;   // s-a salvat sau modificat între timp
    if (!r || r.id == null || (r.id === currentVersionId && r.rev === currentRev)) return;
    if (dirty || inflight || saveBusy || modalBlocks()) return;   // a început să lucreze între timp: se ocupă salvarea
    loadLatest(r, { silent: true });
  } catch (e) { /* fără internet etc.: rămâne ce e */ }
  finally { refreshing = false; }
}
function noteActivity() {
  const now = Date.now(), idle = now - lastActivity >= IDLE_MS;
  lastActivity = now;
  if (idle) refreshIfStale();
}

// Trimite CV-ul la server. Nu rulează niciodată două salvări deodată: o salvare nouă
// așteaptă salvarea în curs, apoi trimite doar dacă mai sunt modificări.
// Întoarce true dacă ce e pe ecran e salvat ca ultimă versiune.
export async function saveNow(kind) {
  const epoch = conflictEpoch;
  clearTimeout(autoTimer); autoTimer = null;
  while (inflight) await inflight;
  clearTimeout(autoTimer); autoTimer = null;
  if (conflictEpoch !== epoch) return false;
  if (!dirty) return true;

  const seq = editSeq, data = clone(state);
  let ok = false, offline = false;
  inflight = (async () => {
    setStatus("Se salvează…");
    try {
      const r = await api.saveCv(data, currentBase(), kind);
      if (conflictEpoch !== epoch) return;            // între timp s-a încărcat altă variantă
      if (r && r.latest) {
        currentVersionId = r.id; currentRev = r.rev; ok = true;
        if (editSeq === seq) dirty = false;
        setStatus(dirty ? "Nesalvat" : "Salvat ✓ " + hhmm(new Date()));
      } else {
        loadLatest(r && r.current, { base: data, mine: state });
      }
    } catch (err) {
      setStatus("Nesalvat");
      offline = isOffline(err);
      if (kind === "manual") {
        toast(offline ? "Nu ai internet. CV-ul nu s-a salvat încă." : "Nu am putut salva acum. Încearcă din nou.", 5000);
      }
    }
  })();
  try { await inflight; } finally { inflight = null; }
  // modificări făcute cât timp se salva, sau fără internet: încă o salvare automată mai târziu
  if (dirty && !autoTimer && conflictEpoch === epoch && (ok || offline)) {
    autoTimer = setTimeout(() => { autoTimer = null; saveNow("auto"); }, ok ? AUTO_SAVE_MS : RETRY_OFFLINE_MS);
  }
  return ok && conflictEpoch === epoch;
}

let saveBusy = false;
async function onSaveClick() {
  if (saveBusy) return;
  saveBusy = true; $("#saveBtn").disabled = true;
  applyPersonalForm();
  const epoch = conflictEpoch;
  showModal(`<div class="busy"><div class="spin"></div>Se salvează… câteva secunde.</div>`);
  try {
    const translated = await translateMissing().catch(() => false);
    if (conflictEpoch !== epoch) return;              // fereastra „schimbat pe celălalt dispozitiv” e deja afișată
    const saved = await saveNow("manual");
    if (conflictEpoch !== epoch) return;
    if (!saved) { closeModal(); return; }             // mesajul (fără internet etc.) e deja afișat
    if (!translated) {
      showModal(`<h2>CV-ul e salvat</h2>
        <div class="err-box">CV-ul e salvat. PDF-ul nu s-a putut face acum.</div>
        <div class="modal-actions">
          <button class="btn btn-light btn-big" id="mNo">Închide</button>
          <button class="btn btn-green btn-big" id="mRetry">🔄 Încearcă din nou</button></div>`);
      $("#mNo").onclick = closeModal;
      $("#mRetry").onclick = onSaveClick;
      return;
    }
    closeModal();
    await savePdf();
  } catch (e) {
    console.error(e); closeModal(); toast("Nu am putut face PDF-ul. Încearcă din nou.");
  } finally {
    saveBusy = false; $("#saveBtn").disabled = false;
  }
}

/* ================================================================ translation (prin server) */
const S = v => String(v ?? "");

async function translateEntry(kind, e) {
  const r = e.ro;
  const out = await api.translate({
    kind: "entry", section: kind, current: !!e.current,
    input: { role: S(r.role), employer: S(r.employer), place: S(r.place), subtitle: S(r.subtitle), lines: (r.lines || []).map(S) }
  });
  return {
    role: S(out.role).trim(), employer: S(out.employer).trim(), place: S(out.place).trim(), subtitle: S(out.subtitle).trim(),
    lines: Array.isArray(out.lines) ? out.lines.map(s => S(s).trim()).filter(Boolean) : []
  };
}

async function translatePersonal(p) {
  const input = {};
  for (const k of PERSONAL) input[k] = S(p[k]);
  const out = await api.translate({ kind: "personal", input });
  const r = {};
  for (const k of PERSONAL) r[k] = S(out[k]).trim();
  return r;
}
const PERSONAL = ["name", "birth", "nationality", "phone", "email", "address"];

function readPersonalForm() {
  if (!$("#p-name")) return null;
  const ro = {};
  for (const k of PERSONAL) ro[k] = $("#p-" + k).value.trim();
  return ro;
}
// Pune în CV ce e scris acum în formularul de date personale (fără să redeseneze formularul).
let typingSnap = false;
function applyPersonalForm() {
  const ro = readPersonalForm();
  if (!ro || sig(ro) === sig(state.personal.ro)) return;
  if (!typingSnap) { snapshot(); typingSnap = true; }
  state.personal.ro = ro; markDirty();
}

const personalMissing = () => !isTranslated(state.personal) && !!state.personal.ro.name;

// Traduce tot ce nu e tradus încă. Întoarce true dacă la final totul e tradus.
export async function translateMissing() {
  const st = state;
  let changed = false, stop = false;
  const apply = () => { if (!changed) { snapshot(); changed = true; } };
  for (const kind of ["work", "education"]) {
    for (const e of st[kind]) {
      if (stop || isTranslated(e)) continue;
      const s = sig(e.ro);
      try {
        const en = await translateEntry(kind, e);
        if (state !== st || !st[kind].includes(e) || sig(e.ro) !== s) continue;
        apply(); e.en = en; e.sig = s;
      } catch (err) { stop = true; }                  // fără internet, limită sau Gemini indisponibil: nu mai încerca acum
    }
  }
  if (!stop && personalMissing()) {
    const ro = st.personal.ro, s = sig(ro);
    try {
      const en = await translatePersonal(ro);
      if (state === st && sig(st.personal.ro) === s) { apply(); st.personal.en = en; st.personal.sig = s; }
    } catch (err) { /* rămâne netradus */ }
  }
  if (changed && state === st) commit();
  return state === st && [...st.work, ...st.education].every(isTranslated) && !personalMissing();
}

function errMsg(err) {
  if (isOffline(err)) return "Nu ai internet acum. Verifică conexiunea (Wi-Fi sau date mobile) și încearcă din nou.";
  if (err && err.code === "limit") return "Ai tradus foarte mult azi. Încearcă mâine.";
  return "Nu am putut traduce acum. Încearcă din nou peste un minut.";
}

/* ================================================================ render */
function render() {
  typingSnap = false;
  document.querySelectorAll(".nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
  const v = $("#view");
  if (tab === "work" || tab === "education") v.innerHTML = listHTML(tab);
  else if (tab === "personal") v.innerHTML = personalHTML();
  else if (tab === "other") v.innerHTML = otherHTML();
  else { v.innerHTML = cvHTML(); renderPreview(); }
}

function listHTML(kind) {
  const list = state[kind], isWork = kind === "work";
  let h = `<h2>${isWork ? "🛠️ Locuri de muncă" : "🎓 Studii și cursuri"}</h2>
    <p class="hint">Ordinea de aici e ordinea din CV. Cu <b>⬆ Sus</b> și <b>⬇ Jos</b> schimbi locurile între ele.</p>
    <button class="btn btn-blue btn-big btn-block" data-act="add" data-kind="${kind}">＋ ${isWork ? "Adaugă loc de muncă" : "Adaugă studii sau curs"}</button>
    <div class="list">`;
  if (!list.length) h += `<p class="hint">Nu ai adăugat nimic încă. Apasă butonul albastru de mai sus.</p>`;
  list.forEach((e, i) => {
    const what = esc(e.ro.role || "(fără titlu)") + (e.ro.employer ? " – " + esc(e.ro.employer) : "");
    const enLine = e.en ? esc((e.en.role || "") + (e.en.employer ? " - " + e.en.employer : "")) : "";
    h += `<div class="entry" id="entry-${esc(e.id)}">
      <div class="entry-head"><div class="num">${i + 1}</div><div style="min-width:0">
        <div class="when">${esc(dateText(e, "ro") || "fără dată")}</div>
        <div class="what">${what}</div>
        ${e.ro.place ? `<div class="where">📍 ${esc(e.ro.place)}</div>` : ""}
        ${isTranslated(e) ? `<div class="en">🇬🇧 ${enLine}</div>` : `<div class="badge">⚠ Încă netradus</div>`}
      </div></div>
      <div class="actions">
        <button class="btn btn-blue wide" data-act="edit" data-kind="${kind}" data-i="${i}">✏️ Modifică</button>
        <button class="btn btn-light" data-act="up" data-kind="${kind}" data-i="${i}" ${i === 0 ? "disabled" : ""}>⬆ Sus</button>
        <button class="btn btn-light" data-act="down" data-kind="${kind}" data-i="${i}" ${i === list.length - 1 ? "disabled" : ""}>⬇ Jos</button>
        ${isTranslated(e) ? "" : `<button class="btn btn-orange wide" data-act="tr" data-kind="${kind}" data-i="${i}">🌐 Tradu acum</button>`}
        <button class="btn btn-red wide" data-act="del" data-kind="${kind}" data-i="${i}">🗑 Șterge</button>
      </div></div>`;
  });
  h += `</div>`;
  if (list.length > 1) h += `<button class="btn btn-light btn-block" style="margin-top:16px" data-act="sort" data-kind="${kind}">📅 Pune în ordine după dată</button>`;
  return h;
}

function personalHTML() {
  const p = state.personal.ro;
  const f = (k, lbl, ex, type = "text", mode = "") => `<div class="field"><label for="p-${k}">${lbl}</label>${ex ? `<span class="ex">${ex}</span>` : ""}<input id="p-${k}" type="${type}" ${mode} value="${esc(p[k])}"></div>`;
  return `<h2>👤 Date personale</h2>
    <p class="hint">Apar sus, în capul CV-ului.</p>
    <div class="photo-row">${state.personal.photo ? `<img src="${esc(state.personal.photo)}" alt="Poza din CV">` : `<img alt="Fără poză">`}
      <label class="btn btn-light" style="cursor:pointer">📷 ${state.personal.photo ? "Schimbă poza" : "Pune o poză"}<input type="file" accept="image/*" id="photoIn" class="sr"></label></div>
    ${f("name", "Numele complet", "ex: Ion Popescu")}
    ${f("birth", "Data nașterii", "ex: 01/01/1970", "text", 'inputmode="numeric"')}
    ${f("nationality", "Naționalitatea", "ex: Română")}
    ${f("phone", "Telefon", "ex: (+40) 7xx xxx xxx", "tel")}
    ${f("email", "Adresa de e-mail", "", "email")}
    ${f("address", "Adresa", "ex: România")}
    <div id="pErr"></div>
    <button class="btn btn-green btn-big btn-block" id="pSave">💾 Salvează și tradu</button>
    ${isTranslated(state.personal) ? "" : `<p class="badge">⚠ Datele personale încă nu sunt traduse. Apasă butonul verde.</p>`}`;
}

const levelSelect = (id, val) => `<select id="${id}">${LEVELS.map(([v, t]) => `<option value="${v}" ${v === val ? "selected" : ""}>${v} – ${t}</option>`).join("")}</select>`;
const langSelect = (id, val) => `<select id="${id}">${Object.keys(LANGS).map(k => `<option ${k === val ? "selected" : ""}>${k}</option>`).join("")}</select>`;

function otherHTML() {
  const L = state.languages;
  let h = `<h2>🌍 Limbi străine</h2>
    <div class="field"><label for="mother">Limba maternă</label>${langSelect("mother", L.mother)}</div>
    <p class="hint">Pentru fiecare limbă străină alege nivelul (A1 = începător … C2 = foarte avansat).</p>`;
  L.foreign.forEach((f, i) => {
    h += `<div class="langrow">
      <div class="field" style="margin-bottom:8px"><label for="fl-${i}">Limba</label>${langSelect("fl-" + i, f.name)}</div>
      <div class="levels">
        <div><label for="lv-${i}-listening">Ascultare</label>${levelSelect(`lv-${i}-listening`, f.listening)}</div>
        <div><label for="lv-${i}-reading">Citire</label>${levelSelect(`lv-${i}-reading`, f.reading)}</div>
        <div><label for="lv-${i}-production">Vorbire</label>${levelSelect(`lv-${i}-production`, f.production)}</div>
        <div><label for="lv-${i}-interaction">Conversație</label>${levelSelect(`lv-${i}-interaction`, f.interaction)}</div>
        <div><label for="lv-${i}-writing">Scriere</label>${levelSelect(`lv-${i}-writing`, f.writing)}</div>
      </div>
      <button class="btn btn-red btn-block" style="margin-top:12px" data-act="ldel" data-i="${i}">🗑 Șterge limba</button></div>`;
  });
  h += `<button class="btn btn-blue btn-block" data-act="ladd">＋ Adaugă o limbă străină</button>
    <hr class="sep"><h2>🚗 Permis de conducere</h2>
    <p class="hint">Bifează categoriile pe care le ai.</p>
    <div class="chips">${LICENCES.map(c => `<label class="chip"><input type="checkbox" data-lic="${c}" ${state.driving.includes(c) ? "checked" : ""}> ${c}</label>`).join("")}</div>`;
  return h;
}

function cvHTML() {
  const missing = [...state.work, ...state.education].filter(e => !isTranslated(e)).length + (isTranslated(state.personal) || !state.personal.ro.name ? 0 : 1);
  return `<h2>📄 CV-ul tău (în engleză)</h2>
    <p class="hint">Așa arată CV-ul. Când e gata, apasă butonul verde.</p>
    ${missing ? `<div class="err-box">⚠ ${missing === 1 ? "O parte nu este tradusă" : missing + " părți nu sunt traduse"} încă. Caută semnul portocaliu „Încă netradus” și apasă „🌐 Tradu acum”.</div>` : ""}
    <button class="btn btn-green btn-big btn-block dl">⬇ Descarcă CV-ul (PDF)</button>
    <div class="pages" id="pages"><div class="msg">Se pregătește CV-ul…</div></div>
    <button class="btn btn-green btn-big btn-block dl">⬇ Descarcă CV-ul (PDF)</button>`;
}

/* ================================================================ events */
function bindEvents() {
document.addEventListener("click", ev => {
  const t = ev.target.closest("button");
  if (!t) return;
  if (t.closest(".nav")) { tab = t.dataset.tab; render(); window.scrollTo({ top: 0 }); return; }
  if (t.classList.contains("dl")) { download(); return; }
  const act = t.dataset.act; if (!act) return;
  const kind = t.dataset.kind, i = +t.dataset.i;
  if (act === "add") openEditor(kind, -1);
  else if (act === "edit") openEditor(kind, i);
  else if (act === "up" || act === "down") move(kind, i, act === "up" ? -1 : 1);
  else if (act === "del") askDelete(kind, i);
  else if (act === "tr") quickTranslate(kind, i);
  else if (act === "sort") sortByDate(kind);
  else if (act === "ladd") { snapshot(); state.languages.foreign.push({ name: "Engleză", listening: "A2", reading: "A2", production: "A2", interaction: "A2", writing: "A2" }); commit(); }
  else if (act === "ldel") { snapshot(); state.languages.foreign.splice(i, 1); commit(); }
});

document.addEventListener("change", ev => {
  const t = ev.target;
  if (t.id === "mother") { snapshot(); state.languages.mother = t.value; commit(); }
  else if (/^fl-\d+$/.test(t.id)) { snapshot(); state.languages.foreign[+t.id.slice(3)].name = t.value; commit(); }
  else if (/^lv-\d+-/.test(t.id)) { const [, i, k] = t.id.split("-"); snapshot(); state.languages.foreign[+i][k] = t.value; commit(); }
  else if (t.dataset.lic) {
    snapshot();
    const set = new Set(state.driving); t.checked ? set.add(t.dataset.lic) : set.delete(t.dataset.lic);
    state.driving = LICENCES.filter(c => set.has(c)); commit();
  }
  else if (t.id === "photoIn" && t.files[0]) loadPhoto(t.files[0]);
});

document.addEventListener("click", async ev => {
  if (ev.target.id !== "pSave") return;
  const btn = ev.target;
  const ro = {};
  for (const k of ["name", "birth", "nationality", "phone", "email", "address"]) ro[k] = $("#p-" + k).value.trim();
  if (sig(ro) !== sig(state.personal.ro)) snapshot();
  state.personal.ro = ro;
  btn.disabled = true; btn.textContent = "⏳ Se traduce…"; $("#pErr").innerHTML = "";
  const epoch = conflictEpoch;
  try {
    const en = await translatePersonal(ro);
    if (conflictEpoch !== epoch) return;             // CV-ul a fost înlocuit cu varianta de pe celălalt dispozitiv
    state.personal.en = en;
    state.personal.sig = sig(ro);
    commit(); toast("✓ Salvat și tradus.");
  } catch (err) {
    if (conflictEpoch !== epoch) return;
    commit(); $("#pErr").innerHTML = `<div class="err-box">${esc(errMsg(err))}</div>`;
  }
});

$("#undoBtn").addEventListener("click", undo);
$("#setBtn").addEventListener("click", openSettings);
$("#saveBtn").addEventListener("click", onSaveClick);

// datele personale ajung în CV pe măsură ce le scrie (fără să apese „Salvează și tradu”)
document.addEventListener("input", ev => { if (/^p-/.test(ev.target.id)) applyPersonalForm(); });

// la închiderea paginii sau când telefonul trece la altă aplicație: salvează ce nu e salvat;
// la revenire: arată varianta de pe server, dacă între timp s-a salvat pe celălalt dispozitiv
window.addEventListener("beforeunload", () => { if (dirty) saveNow("auto"); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { if (dirty) saveNow("auto"); }
  else { lastActivity = Date.now(); refreshIfStale(); }
});
document.addEventListener("pointerdown", noteActivity, true);
document.addEventListener("keydown", noteActivity, true);
}

function move(kind, i, d) {
  const list = state[kind], j = i + d;
  if (j < 0 || j >= list.length) return;
  snapshot(); [list[i], list[j]] = [list[j], list[i]]; commit(); flash(list[j].id);
}
function flash(id) {
  const el = document.getElementById("entry-" + id);
  if (!el) return;
  el.classList.add("flash"); el.scrollIntoView({ block: "center", behavior: "smooth" });
  setTimeout(() => el.classList.remove("flash"), 900);
}
function sortByDate(kind) {
  snapshot();
  state[kind].sort((a, b) => (endKey(b) - endKey(a)) || (startKey(b) - startKey(a)));
  commit(); toast("Am pus în ordine, de la cel mai nou la cel mai vechi.");
}

function askDelete(kind, i) {
  const e = state[kind][i];
  showModal(`<h2>Ștergi?</h2>
    <p class="sub">Sigur vrei să ștergi <b>${esc(e.ro.role || "această intrare")}</b>${e.ro.employer ? " de la <b>" + esc(e.ro.employer) + "</b>" : ""}?</p>
    <p class="hint">Dacă te răzgândești, apasă „↶ Înapoi” sus.</p>
    <div class="modal-actions"><button class="btn btn-light btn-big" id="mNo">Nu</button>
    <button class="btn btn-big" style="background:var(--red);color:#fff" id="mYes">Da, șterge</button></div>`);
  $("#mNo").onclick = closeModal;
  $("#mYes").onclick = () => { snapshot(); state[kind].splice(i, 1); closeModal(); commit(); toast("Am șters."); };
}

async function quickTranslate(kind, i) {
  const e = state[kind][i];
  showModal(`<div class="busy"><div class="spin"></div>Se traduce în engleză…</div>`);
  const epoch = conflictEpoch;
  try {
    const en = await translateEntry(kind, e);
    if (conflictEpoch !== epoch) return;
    snapshot(); e.en = en; e.sig = sig(e.ro);
    closeModal(); commit(); flash(e.id); toast("✓ Tradus.");
  } catch (err) {
    if (conflictEpoch !== epoch) return;
    showModal(`<h2>Nu s-a putut traduce</h2><div class="err-box">${esc(errMsg(err))}</div>
      <div class="modal-actions one"><button class="btn btn-light btn-big" id="mNo">Închide</button></div>`);
    $("#mNo").onclick = closeModal;
  }
}

function loadPhoto(file) {
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => {
    const s = Math.min(img.width, img.height), size = 400;
    const c = document.createElement("canvas"); c.width = c.height = size;
    c.getContext("2d").drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
    snapshot(); state.personal.photo = c.toDataURL("image/jpeg", 0.85);
    URL.revokeObjectURL(url); commit(); toast("✓ Am pus poza.");
  };
  img.onerror = () => toast("Nu am putut deschide poza. Încearcă alta.");
  img.src = url;
}

/* ================================================================ modal / editor */
function showModal(html) { $("#modal").innerHTML = html; $("#modalBack").classList.add("show"); $("#modalBack").scrollTop = 0; document.body.style.overflow = "hidden"; }
function closeModal() { $("#modalBack").classList.remove("show"); $("#modal").innerHTML = ""; document.body.style.overflow = ""; }

const monthSel = (id, v) => `<select id="${id}" aria-label="Luna">${LUNI.map((n, i) => `<option value="${i}" ${i === (v || 0) ? "selected" : ""}>${i ? n : "— luna —"}</option>`).join("")}</select>`;
function yearSel(id, v) {
  let o = `<option value="0">— anul —</option>`;
  for (let y = THIS_YEAR + 1; y >= 1960; y--) o += `<option ${y === v ? "selected" : ""}>${y}</option>`;
  return `<select id="${id}" aria-label="Anul">${o}</select>`;
}

let editing = null;

function openEditor(kind, index) {
  const isWork = kind === "work";
  const e = index >= 0 ? clone(state[kind][index]) :
    { id: uid(), sm: 0, sy: 0, em: 0, ey: 0, current: false, ro: { role: "", employer: "", place: "", subtitle: "", lines: [] }, en: null };
  editing = { kind, index, draft: e, pending: true };   // pending: ce scrie aici nu e încă în CV
  const r = e.ro;
  const T = isWork ? {
    head: index >= 0 ? "Modifică locul de muncă" : "Loc de muncă nou",
    role: ["Ce funcție ai avut?", "ex: Electrician"],
    emp: ["La ce firmă?", "ex: SC Exemplu SRL"],
    lines: ["Ce ai făcut acolo?", "Scrie fiecare lucru pe un rând nou (apasă Enter după fiecare). Fiecare rând devine un punct separat în CV."]
  } : {
    head: index >= 0 ? "Modifică studiile / cursul" : "Studii sau curs nou",
    role: ["Ce calificare sau diplomă ai obținut?", "ex: Electrician în instalații energetice"],
    emp: ["La ce școală?", "ex: Liceul Tehnologic Exemplu (poți lăsa gol)"],
    lines: ["Ce ai învățat? (poți lăsa gol)", "Scrie fiecare lucru pe un rând nou."]
  };
  showModal(`
    <h2>${T.head}</h2>
    <p class="sub">Scrie în română. Se traduce singur când apeși „Salvează”.</p>
    <div class="field"><label for="f-role">${T.role[0]}</label><span class="ex">${T.role[1]}</span><input id="f-role" type="text" value="${esc(r.role)}"></div>
    <div class="field"><label for="f-emp">${T.emp[0]}</label><span class="ex">${T.emp[1]}</span><input id="f-emp" type="text" value="${esc(r.employer)}"></div>
    <div class="field"><label for="f-place">În ce oraș și țară?</label><span class="ex">ex: Paris, Franța</span><input id="f-place" type="text" value="${esc(r.place)}"></div>
    <div class="datebox"><span class="lbl">📅 De când?</span><div class="row2">${monthSel("f-sm", e.sm)}${yearSel("f-sy", e.sy)}</div></div>
    <div class="datebox"><span class="lbl">📅 Până când?</span><div class="row2" id="endRow">${monthSel("f-em", e.em)}${yearSel("f-ey", e.ey)}</div>
      ${isWork ? `<label class="check"><input type="checkbox" id="f-cur" ${e.current ? "checked" : ""}> Lucrez încă aici</label>` : `<p class="hint" style="margin:8px 0 0">Dacă nu vrei dată în CV, lasă „— anul —”.</p>`}</div>
    ${isWork ? `<div class="field"><label for="f-sub">Titlu scurt deasupra listei (opțional)</label><span class="ex">De obicei se lasă gol.</span><input id="f-sub" type="text" value="${esc(r.subtitle)}"></div>` : ""}
    <div class="field"><label for="f-lines">${T.lines[0]}</label><span class="ex">${T.lines[1]}</span><textarea id="f-lines">${esc(r.lines.join("\n"))}</textarea>
      <div class="tip">🎤 Nu vrei să scrii? Apasă pe microfonul de pe tastatura telefonului și vorbește.</div></div>
    <div id="fErr"></div>
    <div class="modal-actions">
      <button class="btn btn-light btn-big" id="fCancel">Renunță</button>
      <button class="btn btn-green btn-big" id="fSave">💾 Salvează</button>
    </div>`);
  bindEditor();
}
function bindEditor() {
  const cur = $("#f-cur");
  const syncCur = () => { if (cur) { $("#endRow").style.opacity = cur.checked ? .35 : 1; $("#f-em").disabled = $("#f-ey").disabled = cur.checked; } };
  if (cur) { cur.onchange = syncCur; syncCur(); }
  $("#fCancel").onclick = () => { editing.pending = false; closeModal(); };
  $("#fSave").onclick = saveEditor;
}
function fillEditor(e) {
  $("#f-role").value = e.ro.role; $("#f-emp").value = e.ro.employer; $("#f-place").value = e.ro.place;
  if ($("#f-sub")) $("#f-sub").value = e.ro.subtitle;
  $("#f-lines").value = e.ro.lines.join("\n");
  $("#f-sm").value = e.sm; $("#f-sy").value = e.sy; $("#f-em").value = e.em; $("#f-ey").value = e.ey;
  if ($("#f-cur")) $("#f-cur").checked = e.current;
}

function readEditor() {
  const e = editing.draft;
  e.ro = {
    role: $("#f-role").value.trim(), employer: $("#f-emp").value.trim(), place: $("#f-place").value.trim(),
    subtitle: $("#f-sub") ? $("#f-sub").value.trim() : "",
    lines: $("#f-lines").value.split("\n").map(s => s.replace(/^\s*[-•*·]\s*/, "").trim()).filter(Boolean)
  };
  e.sm = +$("#f-sm").value; e.sy = +$("#f-sy").value;
  e.current = $("#f-cur") ? $("#f-cur").checked : false;
  e.em = e.current ? 0 : +$("#f-em").value; e.ey = e.current ? 0 : +$("#f-ey").value;
  return e;
}
function validate(e) {
  if (!e.ro.role) return "Scrie te rog funcția / calificarea (primul câmp).";
  if (editing.kind === "work" && !e.sy) return "Alege te rog anul în care ai început (la „De când?”).";
  if (e.sm && !e.sy) return "Ai ales luna, dar nu și anul de început.";
  if (e.em && !e.ey && !e.current) return "Ai ales luna de final, dar nu și anul.";
  if (e.ey && e.sy && !e.current && (e.ey * 100 + e.em) < (e.sy * 100 + e.sm)) return "Data de final e înainte de data de început. Verifică datele.";
  return "";
}

async function saveEditor() {
  const e = readEditor();
  const msg = validate(e);
  if (msg) { $("#fErr").innerHTML = `<div class="err-box">${esc(msg)}</div>`; $("#fErr").scrollIntoView({ block: "center" }); return; }
  const { kind, index } = editing;
  if (e.en && e.sig === sig(e.ro)) { putEntry(kind, index, e); closeModal(); toast("✓ Salvat."); return; }
  showModal(`<div class="busy"><div class="spin"></div>Se traduce în engleză… câteva secunde.</div>`);
  const epoch = conflictEpoch;
  try {
    e.en = await translateEntry(kind, e); e.sig = sig(e.ro);
    if (conflictEpoch !== epoch) return;             // CV-ul a fost înlocuit; fereastra de avertizare e afișată
    putEntry(kind, index, e); showReview(kind, e);
  } catch (err) {
    if (conflictEpoch !== epoch) return;
    showModal(`<h2>Nu s-a putut traduce</h2>
      <div class="err-box">${esc(errMsg(err))}</div>
      <p class="hint">Poți salva acum și traduce mai târziu cu butonul portocaliu „Tradu acum”.</p>
      <div class="modal-actions">
        <button class="btn btn-light btn-big" id="rLater">Salvează fără traducere</button>
        <button class="btn btn-green btn-big" id="rRetry">🔄 Încearcă iar</button></div>`);
    $("#rLater").onclick = () => { putEntry(kind, index, e); closeModal(); toast("Salvat. Nu uita „Tradu acum”."); };
    $("#rRetry").onclick = () => { openEditor(kind, index); fillEditor(e); editing.draft = e; saveEditor(); };
  }
}

function putEntry(kind, index, e) {
  if (editing) editing.pending = false;
  snapshot();
  if (index >= 0) state[kind][index] = e;
  else {
    const list = state[kind];
    let pos = e.sy ? list.findIndex(x => endKey(x) < endKey(e) || (endKey(x) === endKey(e) && startKey(x) < startKey(e))) : -1;
    list.splice(pos < 0 ? list.length : pos, 0, e);
  }
  commit();
}

function showReview(kind, e) {
  const en = e.en;
  const meta = [dateText(e, "en"), en.place].filter(Boolean).join("  ·  ");
  const title = en.role + (en.employer ? (kind === "work" ? " - " : " – ") + en.employer : "");
  showModal(`<h2>✓ Gata! Așa apare în CV:</h2>
    <p class="sub">Tradus automat în engleză.</p>
    <div class="review">
      ${meta ? `<div class="rmeta">${esc(meta)}</div>` : ""}
      <div class="rtitle">${esc(title)}</div>
      ${en.subtitle ? `<div>${esc(en.subtitle)}</div>` : ""}
      ${en.lines.length ? `<ul>${en.lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="modal-actions">
      <button class="btn btn-light btn-big" id="rEdit">✏️ Mai schimb</button>
      <button class="btn btn-green btn-big" id="rOk">👍 E bine</button>
    </div>`);
  $("#rOk").onclick = () => { closeModal(); flash(e.id); };
  $("#rEdit").onclick = () => { const i = state[kind].findIndex(x => x.id === e.id); closeModal(); openEditor(kind, i); };
}

/* ================================================================ settings / history */
function openSettings() {
  showModal(`<h2>⚙️ Setări</h2>
    <p class="sub">De obicei nu ai nevoie de nimic de aici.</p>
    <button class="btn btn-blue btn-big btn-block" id="sHist">🕘 Versiuni anterioare</button>
    <p class="hint" style="margin-top:8px">Vezi cum arăta CV-ul înainte și poți reveni la o variantă mai veche.</p>
    <hr class="sep">
    <button class="btn btn-light btn-big btn-block" id="sOut">🚪 Ieșire</button>
    <p class="hint" style="margin-top:8px">Data viitoare îți cere din nou PIN-ul.</p>
    <div class="modal-actions one"><button class="btn btn-light btn-big" id="sClose">Închide</button></div>`);
  $("#sClose").onclick = closeModal;
  $("#sHist").onclick = openHistory;
  $("#sOut").onclick = signOut;
}

async function signOut() {
  const b = $("#sOut");
  b.disabled = true; b.textContent = "⏳ Un moment…";
  applyPersonalForm();
  if (dirty || inflight) {
    const ok = await saveNow("manual");
    if (!ok) { if ($("#sOut")) openSettings(); return; }   // fără internet: rămâi în aplicație, nimic nu se pierde
  }
  await api.logout();
  location.reload();
}

const longDate = ms => { const d = new Date(ms); return d.getDate() + " " + LUNI[d.getMonth() + 1].toLowerCase() + " " + d.getFullYear() + ", " + hhmm(d); };
const deviceText = v => (v.kind === "import" ? "Încărcat de pe calculator" : S(v.device)) + (v.kind === "restore" ? " · revenire la o versiune veche" : "");
const busyHTML = t => `<div class="busy"><div class="spin"></div>${esc(t)}</div>`;

function historyError(err, retry) {
  showModal(`<h2>Nu merge acum</h2>
    <div class="err-box">${isOffline(err) ? "Nu ai internet. Încearcă din nou." : "Ceva nu a mers. Încearcă din nou."}</div>
    <div class="modal-actions">
      <button class="btn btn-light btn-big" id="mNo">Închide</button>
      <button class="btn btn-green btn-big" id="mRetry">🔄 Încearcă din nou</button></div>`);
  $("#mNo").onclick = closeModal;
  $("#mRetry").onclick = retry;
}

export function openHistory() { showHistory().catch(err => { console.error(err); historyError(err, openHistory); }); }

async function showHistory() {
  showModal(busyHTML("Se încarcă versiunile…"));
  let list;
  try { list = await api.listVersions(); } catch (err) { return historyError(err, openHistory); }
  const rows = list.map((v, i) => `<button class="btn btn-light btn-block hist-row" data-hv="${i}">
      <span class="hist-date">${esc(longDate(v.updatedAt || v.createdAt))}${v.latest ? " <b>(acum)</b>" : ""}</span>
      <span class="hist-dev">${esc(deviceText(v))}</span></button>`).join("");
  showModal(`<h2>🕘 Versiuni anterioare</h2>
    <p class="sub">Apasă pe o versiune ca s-o vezi.</p>
    ${list.length ? `<div class="list">${rows}</div>` : `<p class="hint">Nu există încă nicio versiune salvată.</p>`}
    <div class="modal-actions one"><button class="btn btn-light btn-big" id="hClose">Închide</button></div>`);
  $("#hClose").onclick = closeModal;
  document.querySelectorAll("#modal [data-hv]").forEach(b => { b.onclick = () => openVersion(list[+b.dataset.hv]); });
}

async function openVersion(v) {
  showModal(busyHTML("Se pregătește…"));
  let ver;
  try { ver = await api.getVersion(v.id); } catch (err) { return historyError(err, () => openVersion(v)); }
  const temp = normalize(clone(ver.data || EMPTY()));
  showModal(`<h2>${esc(longDate(v.updatedAt || v.createdAt))}${v.latest ? " (acum)" : ""}</h2>
    <p class="sub">${v.latest ? "Aceasta este varianta de acum." : "Așa arăta CV-ul atunci."}</p>
    <div class="pages" id="hPages"><div class="msg">Se pregătește CV-ul…</div></div>
    <div class="modal-actions${v.latest ? " one" : ""}">
      <button class="btn btn-light btn-big" id="hBack">⬅ Înapoi</button>
      ${v.latest ? "" : `<button class="btn btn-green btn-big" id="hRestore">Revino la versiunea aceasta</button>`}</div>`);
  $("#hBack").onclick = openHistory;
  if (!v.latest) $("#hRestore").onclick = () => restoreTo(v, temp);
  renderPreview($("#hPages"), temp);
}

async function restoreTo(v, data) {
  const label = "Revino la versiunea aceasta";
  const setBtn = busy => { const b = $("#hRestore"); if (b) { b.disabled = busy; b.textContent = busy ? "⏳ Un moment…" : label; } };
  setBtn(true);
  const epoch = conflictEpoch;
  // întâi se salvează ce e nesalvat, ca să rămână și acea variantă în istoric
  if (dirty || inflight) {
    if (!(await saveNow("manual"))) { if (conflictEpoch === epoch) setBtn(false); return; }
  }
  let r;
  try { r = await api.restoreVersion(v.id, currentBase()); }
  catch (err) {
    if (conflictEpoch === epoch) setBtn(false);
    toast(isOffline(err) ? "Nu ai internet. Încearcă din nou." : "Nu am putut reveni acum. Încearcă din nou.", 5000);
    return;
  }
  if (conflictEpoch !== epoch) return;
  if (!r || !r.latest) { loadLatest(r && r.current); return; }
  snapshot();                                        // „↶ Înapoi” poate anula revenirea
  state = normalize(clone(data)); currentVersionId = r.id; currentRev = r.rev;
  dirty = false; clearTimeout(autoTimer); autoTimer = null;
  setStatus("Salvat ✓ " + hhmm(new Date()));
  closeModal(); render(); schedulePreview();
  toast("✓ Am revenit la versiunea aleasă.");
}

/* ================================================================ PDF save */
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.rel = "noopener";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const pdfName = () => "CV_" + ((state.personal.en && state.personal.en.name) || state.personal.ro.name || "CV").replace(/\s+/g, "_") + "_EN.pdf";

// Face PDF-ul și îl pune pe telefon. Pe iPhone/iPad, foaia de partajare se deschide doar
// dintr-o apăsare „proaspătă”, deci aici doar arătăm butonul; share() se cheamă în click.
export async function savePdf() {
  await prepareAssets();
  const blob = buildPDF().output("blob"), name = pdfName();
  if (platform() === "ios") {
    const file = new File([blob], name, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { shareModal(file, blob, name); return; }
  }
  saveBlob(blob, name);
  toast("✓ CV-ul a fost descărcat (îl găsești în Descărcări).", 5000);
}

function shareModal(file, blob, name) {
  showModal(`<h2>📄 PDF-ul e gata</h2>
    <p class="sub">Apasă butonul verde, apoi alege „Salvează în Fișiere”.</p>
    <img class="howto" style="display:block;margin:0 auto 10px" src="img/howto-ios-save.svg" alt="Lista telefonului cu opțiunea Salvează în Fișiere evidențiată">
    <div class="modal-actions">
      <button class="btn btn-light btn-big" id="mNo">Închide</button>
      <button class="btn btn-green btn-big" id="mShare">📄 Salvează PDF-ul</button></div>`);
  $("#mNo").onclick = closeModal;
  $("#mShare").onclick = () => {
    navigator.share({ files: [file] }).then(closeModal, err => {
      if (err && err.name === "AbortError") return;    // a închis lista: poate apăsa din nou
      closeModal(); saveBlob(blob, name);
    });
  };
}

/* ================================================================ PDF ENGINE */
const PAGE_W = 595.28, PAGE_H = 841.89, ML = 39, CW = PAGE_W - 78, TOP = 40, BOTTOM = PAGE_H - 36;
const C = { title: [79, 79, 79], body: [90, 89, 89], black: [0, 0, 0], link: [0, 68, 148], rule: [167, 167, 167] };
let fontsB64 = null, logoData = null;

async function fileB64(path) {
  const buf = await (await fetch(path)).arrayBuffer();
  const bytes = new Uint8Array(buf); let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
async function prepareAssets() {
  if (fontsB64) return;
  const [r, b, logo] = await Promise.all([fileB64("fonts/OpenSans-Regular.ttf"), fileB64("fonts/OpenSans-Bold.ttf"), fileB64("img/europass.png")]);
  fontsB64 = { r, b }; logoData = "data:image/png;base64," + logo;
}
function newDoc() {
  const doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4", compress: true });
  doc.addFileToVFS("OS-R.ttf", fontsB64.r); doc.addFont("OS-R.ttf", "OS", "normal");
  doc.addFileToVFS("OS-B.ttf", fontsB64.b); doc.addFont("OS-B.ttf", "OS", "bold");
  doc.setFont("OS", "normal");
  doc.setProperties({ title: "Europass CV" });
  return doc;
}
function font(doc, bold, size, color) { doc.setFont("OS", bold ? "bold" : "normal"); doc.setFontSize(size); doc.setTextColor(...color); }
function txt(doc, s, x, y) { doc.text(s, x, y, { baseline: "top" }); }

function wrapRuns(doc, runs, width, size) {
  const lines = [[]]; let w = 0;
  for (const run of runs) {
    font(doc, run.bold, size, run.color);
    for (const p of String(run.text).split(/(\s+)/).filter(Boolean)) {
      const pw = doc.getTextWidth(p), sp = /^\s+$/.test(p);
      if (!sp && w + pw > width && lines[lines.length - 1].length) { lines.push([]); w = 0; }
      if (sp && w === 0) continue;
      lines[lines.length - 1].push({ ...run, text: p, w: pw }); w += pw;
    }
  }
  return lines;
}
function drawRunLines(doc, lines, x, y, size, lh) {
  for (const line of lines) {
    let cx = x;
    for (const seg of line) {
      font(doc, seg.bold, size, seg.color); txt(doc, seg.text, cx, y);
      if (seg.link && !/^\s+$/.test(seg.text)) {
        doc.setDrawColor(...seg.color); doc.setLineWidth(0.5);
        doc.line(cx, y + size * 1.2, cx + seg.w, y + size * 1.2);
        doc.link(cx, y, seg.w, size * 1.3, { url: seg.link });
      }
      cx += seg.w;
    }
    y += lh;
  }
  return y;
}

function drawHeader(doc, P, photo) {
  doc.setFillColor(244, 244, 244); doc.rect(0, 0, PAGE_W, 154, "F");
  doc.addImage(logoData, "PNG", 425, 28, 145, 34);
  const tx = photo ? 127 : 39;
  if (photo) {
    try {
      doc.saveGraphicsState();
      doc.circle(74, 98, 36, null); doc.clip(); doc.discardPath();
      doc.addImage(photo, photo.startsWith("data:image/png") ? "PNG" : "JPEG", 38, 62, 72, 72);
      doc.restoreGraphicsState();
    } catch (e) { try { doc.restoreGraphicsState(); } catch (_) {} }
    doc.setDrawColor(0, 0, 0); doc.setLineWidth(2); doc.circle(74, 98, 36, "S");
  }
  font(doc, true, 16, C.title); txt(doc, P.name || "", tx, 66);
  doc.setDrawColor(...C.title); doc.setLineWidth(0.8); doc.line(tx, 92, 556, 92);
  const runs = [];
  const add = (lbl, val, link) => {
    if (!val) return;
    if (runs.length) runs.push({ text: " | ", bold: false, color: C.title });
    runs.push({ text: lbl + " ", bold: true, color: C.black });
    runs.push({ text: val, bold: false, color: link ? C.link : C.black, link });
  };
  add("Date of birth:", P.birth); add("Nationality:", P.nationality); add("Phone:", P.phone);
  add("Email address:", P.email, P.email ? "mailto:" + P.email : null); add("Address:", P.address);
  drawRunLines(doc, wrapRuns(doc, runs, 556 - tx, 10).slice(0, 3), tx, 103, 10, 20);
}

const SECTION_H = 42;
function drawSection(doc, y, title) {
  y += 20;
  doc.setFillColor(190, 190, 190); doc.circle(29, y + 7, 2.5, "F");
  font(doc, true, 11, C.black); txt(doc, title.toUpperCase(), ML, y);
  doc.setDrawColor(...C.rule); doc.setLineWidth(1.4); doc.line(ML, y + 17, ML + CW, y + 17);
  return y + 22;
}

function drawItem(doc, kind, e, y, draw, first) {
  const en = isTranslated(e) ? e.en : (e.en || e.ro);
  const isWork = kind === "work";
  y += first ? 2 : 12;
  const meta = [dateText(e, "en"), en.place].filter(Boolean).join("  ·  ").toUpperCase();
  if (meta) {
    font(doc, true, 9, C.title);
    const ml = doc.splitTextToSize(meta, CW);
    if (draw) ml.forEach((l, k) => txt(doc, l, ML, y + k * 12));
    y += ml.length * 12 + 2;
  }
  const runs = [{ text: (en.role || "").toUpperCase(), bold: true, color: C.title }];
  if (en.employer) runs.push({ text: (isWork ? " - " : " – ") + en.employer.toUpperCase(), bold: isWork, color: C.title });
  const tl = wrapRuns(doc, runs, CW, 11);
  if (draw) {
    drawRunLines(doc, tl, ML, y, 11, 15);
    const maxW = Math.min(CW, Math.max(...tl.map(l => l.reduce((a, s) => a + s.w, 0))));
    doc.setDrawColor(...C.title); doc.setLineWidth(0.4); doc.line(ML, y + tl.length * 15 + 2, ML + maxW, y + tl.length * 15 + 2);
  }
  y += tl.length * 15 + 2;
  const lines = en.lines || [];
  if (en.subtitle || lines.length) y += 7;
  if (en.subtitle) {
    font(doc, false, 10, C.body);
    const sl = doc.splitTextToSize(en.subtitle, CW);
    if (draw) sl.forEach((l, k) => txt(doc, l, ML, y + k * 13));
    y += sl.length * 13 + 3;
  }
  font(doc, false, 10, C.body);
  if (!isWork || lines.length === 1) {
    lines.forEach(l => {
      const wl = doc.splitTextToSize(l, CW);
      if (draw) wl.forEach((s, k) => txt(doc, s, ML, y + k * 13));
      y += wl.length * 13 + (isWork ? 0 : 1.5);
    });
  } else {
    lines.forEach(l => {
      const wl = doc.splitTextToSize(l, CW - 25);
      if (draw) { txt(doc, "•", ML + 13, y); wl.forEach((s, k) => txt(doc, s, ML + 25, y + k * 13)); }
      y += wl.length * 13 + 2;
    });
  }
  return y;
}

function buildPDF(cv = state) {
  const doc = newDoc();
  const P = cv.personal.en || cv.personal.ro;
  drawHeader(doc, P, cv.personal.photo);
  let y = 154;
  const ensure = h => { if (y + h > BOTTOM) { doc.addPage(); y = TOP - 20; } };

  for (const [title, kind] of [["Education & Training", "education"], ["Work Experience", "work"]]) {
    cv[kind].forEach((e, i) => {
      const first = i === 0;
      ensure(drawItem(doc, kind, e, 0, false, first) + (first ? SECTION_H : 0));
      if (first) y = drawSection(doc, y, title);
      y = drawItem(doc, kind, e, y, true, first);
    });
  }

  const L = cv.languages, rows = L.foreign.length;
  ensure(SECTION_H + 30 + (rows ? 52 + rows * 30 : 0));
  y = drawSection(doc, y, "Language Skills") + 6;
  font(doc, false, 10, C.body); txt(doc, "Mother tongue(s): ", ML, y);
  const mw = doc.getTextWidth("Mother tongue(s): ");
  font(doc, true, 10, C.title); txt(doc, (LANGS[L.mother] || L.mother).toUpperCase(), ML + mw, y);
  y += 22;
  if (rows) {
    const c0 = 90, cw = (CW - c0) / 5, cx = k => ML + c0 + cw * k + cw / 2;
    const center = (s, x) => doc.text(s, x, y, { align: "center", baseline: "top" });
    font(doc, true, 9, C.title);
    center("UNDERSTANDING", ML + c0 + cw); center("SPEAKING", ML + c0 + cw * 3); center("WRITING", cx(4));
    y += 26;
    font(doc, false, 8.5, C.title);
    ["Listening", "Reading", "Spoken production", "Spoken interaction"].forEach((t, k) => center(t, cx(k)));
    y += 18;
    doc.setDrawColor(...C.title); doc.setLineWidth(0.6); doc.line(ML, y, ML + CW, y);
    L.foreign.forEach(f => {
      y += 9;
      font(doc, true, 9, C.black); center((LANGS[f.name] || f.name).toUpperCase(), ML + c0 / 2);
      font(doc, false, 9, C.black);
      [f.listening, f.reading, f.production, f.interaction, f.writing].forEach((v, k) => center(v || "", cx(k)));
      y += 21; doc.line(ML, y, ML + CW, y);
    });
  }

  if (cv.driving.length) {
    ensure(SECTION_H + 24);
    y = drawSection(doc, y, "Driving Licence") + 6;
    font(doc, true, 10, C.title); txt(doc, "Driving licence: ", ML, y);
    const dw = doc.getTextWidth("Driving licence: ");
    font(doc, false, 10, C.body); txt(doc, cv.driving.join(", "), ML + dw, y);
  }
  return doc;
}

/* ================================================================ preview + download */
function schedulePreview() { if (tab === "cv") { clearTimeout(previewTimer); previewTimer = setTimeout(() => renderPreview(), 300); } }

// Desenează CV-ul (sau o versiune veche, în istoric) în `box`.
async function renderPreview(box = $("#pages"), cv = state) {
  if (!box) return;
  const run = box._run = (box._run || 0) + 1;
  try {
    await prepareAssets();
    const data = buildPDF(cv).output("arraybuffer");
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const frag = document.createDocumentFragment();
    const scale = Math.min(2, (window.devicePixelRatio || 1) * Math.max(1, box.clientWidth / 595));
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n), vp = page.getViewport({ scale });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      c.setAttribute("aria-label", "Pagina " + n);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      frag.appendChild(c);
    }
    if (run !== box._run || !document.body.contains(box)) return;
    box.innerHTML = ""; box.appendChild(frag);
  } catch (e) {
    console.error(e);
    if (run !== box._run || !document.body.contains(box)) return;
    box.innerHTML = `<div class="msg">Previzualizarea nu merge pe acest telefon, dar butonul „Descarcă” funcționează.</div>`;
  }
}

async function download() {
  document.querySelectorAll(".dl").forEach(b => { b.disabled = true; b.dataset.old = b.textContent; b.textContent = "⏳ Se pregătește…"; });
  try {
    await savePdf();
  } catch (e) {
    console.error(e); toast("Nu am putut face PDF-ul. Încearcă din nou.");
  } finally {
    document.querySelectorAll(".dl").forEach(b => { b.disabled = false; b.textContent = b.dataset.old; });
  }
}

/* ================================================================ start */
let started = false;

// Pornește editorul cu CV-ul primit de la server după PIN (vezi main.js).
export function startApp({ cv = null, versionId = null, rev = null } = {}) {
  if (started) return;
  started = true;
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("lib/pdf.worker.min.js", location.href).href;
  state = normalize(cv ? clone(cv) : EMPTY());
  currentVersionId = versionId;
  currentRev = versionId != null ? rev : null;
  if (!cv) tab = "personal";                         // CV gol: începe cu datele personale
  bindEvents();
  lastActivity = Date.now();
  // după ce cere PIN-ul din nou: verifică dacă între timp s-a salvat pe celălalt dispozitiv
  api.setAuthLostHandler(async () => { await askPinAgain(); setTimeout(refreshIfStale, 0); });
  setStatus(cv ? "Salvat ✓" : "");
  render();
  prepareAssets().catch(() => {});
}
