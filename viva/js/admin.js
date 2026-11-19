// Viva admin: assessments, roster, sessions, the live monitor, and review with grading.
// Reads and writes through Supabase with Tim's login; row-level security in schema.sql allows
// only users listed in public.admins.

import { Sketch } from "./draw.js";
import { STARTER, normalize } from "./stencils.js";
import { readAssessment } from "./import.js";

const cfg = window.VIVA || {};
const sb = cfg.supabaseUrl ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
}) : null;

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Each route renders into its own pane, so a slow page that finishes after the user has moved on
// writes into a detached pane instead of over the current page.
let pane = null, seq = 0;
const view = () => pane;
const TZ = "America/New_York";
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) : "";
const fmtDate = (iso) => iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const secs = (ms) => {
  const s = Math.round((Number(ms) || 0) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};
let poll = null;
let me = null;

function studentUrl(code) {
  const u = new URL("./", location.href);
  u.search = ""; u.hash = "";
  return `${u.href}?${code}`;
}
function qrSvg(text, cellSize = 8) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}
function must({ data, error }) {
  if (error) throw new Error(error.message);
  return data;
}
function download(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const csvCell = (v) => /[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? "");

// ---------------------------------------------------------------- sign in

async function boot() {
  if (!sb) { document.body.innerHTML = '<p class="narrow error">Viva is not set up yet (js/config.js).</p>'; return; }
  const { data } = await sb.auth.getSession();
  if (!data.session) { show("login"); show("app", false); return; }
  const admins = await sb.from("admins").select("email");
  if (admins.error || !admins.data.length) {
    show("login"); show("app", false);
    $("login-error").textContent = "This account is not a Viva admin.";
    await sb.auth.signOut();
    return;
  }
  me = data.session.user.email;
  $("who").textContent = me;
  show("login", false); show("app");
  route();
}

$("login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  $("login-error").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: $("login-email").value.trim(), password: $("login-password").value });
  if (error) { $("login-error").textContent = error.message; return; }
  boot();
});
$("logout").addEventListener("click", async () => { await sb.auth.signOut(); location.hash = ""; boot(); });
window.addEventListener("hashchange", route);

function route() {
  clearInterval(poll);
  const my = ++seq;
  const [, page, id] = (location.hash.replace(/^#/, "").split("?")[0] || "/").split("/");
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("on", a.dataset.nav === (page || "home")));
  show("nav", page !== "p");
  const run = { "": home, a: editAssessment, s: sessionPage, p: projector, t: review, roster, shapes }[page || ""] || home;
  pane = document.createElement("div");
  $("view").replaceChildren(pane);
  pane.innerHTML = '<p class="muted">Loading…</p>';
  const mine = pane;
  run(id).catch((e) => { if (my === seq) mine.innerHTML = `<p class="error">${esc(e.message)}</p>`; });
}

// ---------------------------------------------------------------- assessments

const RUBRIC_TEMPLATE = [
  { id: "c1", name: "What it is", description: "Explains the idea in their own words.",
    levels: [{ name: "Met", points: 2, description: "Accurate and in their own words, unprompted." },
             { name: "Partly met", points: 1, description: "Partly right, vague, or only after a pointer." },
             { name: "Not met", points: 0, description: "Missing or wrong." }] },
  { id: "c2", name: "Why it matters", description: "Says when and why you would use it.",
    levels: [{ name: "Met", points: 2 }, { name: "Partly met", points: 1 }, { name: "Not met", points: 0 }] },
];

async function home() {
  const v = view();
  const list = must(await sb.from("assessments").select("id,title,course,time_limit_min,archived,updated_at").order("created_at", { ascending: false }));
  const sessions = must(await sb.from("sessions").select("id,assessment_id,code,label,status,opened_at").order("opened_at", { ascending: false }).limit(30));
  const titles = Object.fromEntries(list.map((a) => [a.id, a.title]));
  v.innerHTML = `
    <div class="row"><h1>Assessments</h1><span class="spacer"></span><a class="btn primary" href="#/a/new">New assessment</a></div>
    <table><thead><tr><th>Title</th><th>Course</th><th class="num">Minutes</th><th>Updated</th></tr></thead><tbody>
      ${list.filter((a) => !a.archived).map((a) => `<tr><td><a href="#/a/${a.id}">${esc(a.title)}</a></td><td>${esc(a.course)}</td>
        <td class="num">${a.time_limit_min}</td><td>${fmtDate(a.updated_at)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">None yet.</td></tr>'}
    </tbody></table>
    <h2>Recent sessions</h2>
    <table><thead><tr><th>Code</th><th>Assessment</th><th>Label</th><th>Status</th><th>Opened</th></tr></thead><tbody>
      ${sessions.map((s) => `<tr><td><a href="#/s/${s.id}"><code>${esc(s.code)}</code></a></td><td>${esc(titles[s.assessment_id] || "")}</td>
        <td>${esc(s.label)}</td><td>${s.status}</td><td>${fmtDate(s.opened_at)}</td></tr>`).join("") || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}
    </tbody></table>`;
}

function checkRubric(r) {
  if (!Array.isArray(r) || !r.length) return "The rubric must be a list with at least one criterion.";
  const ids = new Set();
  for (const c of r) {
    if (!c.id || !c.name) return "Every criterion needs an id and a name.";
    if (ids.has(c.id)) return `Criterion id "${c.id}" is used twice.`;
    ids.add(c.id);
    if (!Array.isArray(c.levels) || c.levels.length < 2) return `Criterion "${c.id}" needs at least two levels.`;
    for (const l of c.levels) {
      if (!l.name || !Number.isFinite(Number(l.points))) return `Every level in "${c.id}" needs a name and points.`;
    }
  }
  return null;
}

async function editAssessment(id) {
  const v = view();
  const isNew = id === "new";
  const a = isNew ? {
    title: "", course: "326", student_intro: "", interviewer_brief: "", opening_question: "", rubric: RUBRIC_TEMPLATE,
    answer_key: "", time_limit_min: 20, min_turns: 3, max_turns: 14, require_screen: true, allow_paste: false, capture_every_sec: 5,
    diagrams: [], allow_drawing: true, ask_confidence: true, transfer_settings: "", revisit_max: 0, hint_limit: 2,
    allow_code: false, code_language: "", allow_math: false,
  } : must(await sb.from("assessments").select("*").eq("id", id).single());
  const sessions = isNew ? [] : must(await sb.from("sessions").select("*").eq("assessment_id", id).order("opened_at", { ascending: false }));
  const library = must(await sb.from("stencils").select("id,name,scene").eq("course", a.course || "326").eq("archived", false).order("sort").order("created_at"));
  const offered = (st) => !Array.isArray(a.stencil_ids) || a.stencil_ids.includes(st.id);
  v.innerHTML = `
    <div class="row"><h1>${isNew ? "New assessment" : esc(a.title)}</h1><span class="spacer"></span>
      ${isNew ? "" : `<button id="open-session" class="primary">Open a session</button>`}</div>
    ${isNew ? "" : `<div class="card" style="margin:1rem 0">
      <div class="row"><label style="margin:0">Session label <span class="muted">(e.g. Tue Feb 10, 8:30)</span></label></div>
      <div class="row"><input id="session-label" style="max-width:20rem"><label class="row" style="margin:0;font-weight:400"><input type="checkbox" id="practice" style="width:auto"> Practice (anyone may join, no roster check)</label></div>
      <table style="margin-top:1rem"><thead><tr><th>Code</th><th>Label</th><th>Status</th><th>Opened</th></tr></thead><tbody>
      ${sessions.map((s) => `<tr><td><a href="#/s/${s.id}"><code>${esc(s.code)}</code></a></td><td>${esc(s.label)}${s.roster_only ? "" : ' <span class="pill">practice</span>'}</td>
        <td>${s.status}</td><td>${fmtDate(s.opened_at)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No sessions yet.</td></tr>'}
      </tbody></table></div>`}
    <details class="card" id="imp" style="margin:1rem 0"${isNew ? " open" : ""}>
      <summary><strong>Fill from JSON</strong> <span class="muted">(an assessment file, such as a "Download for check" file or an example)</span></summary>
      <p class="muted small">Paste the JSON or choose a file. It fills the form below${isNew ? "" : " and replaces what is there"}; nothing is saved until you press Save.</p>
      <textarea id="imp-text" class="json" rows="6" style="min-height:6rem" placeholder='{ "title": "...", "opening_question": "...", "rubric": [ ... ] }'></textarea>
      <p class="row"><button type="button" id="imp-fill">Fill the form</button><input type="file" id="imp-file" accept=".json,application/json" style="width:auto"></p>
      <p class="error" id="imp-error"></p><p class="muted small" id="imp-msg"></p>
    </details>
    <form id="a-form" class="grid2">
      <div>
        <label for="f-title">Title</label><input id="f-title" required value="${esc(a.title)}">
        <label for="f-intro">What students see first <span class="muted">(instructions shown above the chat)</span></label>
        <textarea id="f-intro" rows="3">${esc(a.student_intro)}</textarea>
        <label for="f-opening">Opening question <span class="muted">(the interviewer's first message)</span></label>
        <textarea id="f-opening" rows="3" required>${esc(a.opening_question)}</textarea>
        <label for="f-brief">Interviewer brief <span class="muted">(topic and what to explore; the interviewer sees this, never the rubric or key)</span></label>
        <textarea id="f-brief" rows="6">${esc(a.interviewer_brief)}</textarea>
        <label for="f-key">Answer key and grading notes <span class="muted">(only the evaluator sees this)</span></label>
        <textarea id="f-key" rows="6">${esc(a.answer_key)}</textarea>
        <div class="row">
          <div><label for="f-course">Course</label><input id="f-course" value="${esc(a.course)}" style="width:6rem"></div>
          <div><label for="f-time">Minutes</label><input id="f-time" type="number" min="1" max="180" value="${a.time_limit_min}" style="width:6rem"></div>
          <div><label for="f-min">Min turns</label><input id="f-min" type="number" min="1" max="50" value="${a.min_turns}" style="width:6rem"></div>
          <div><label for="f-max">Max turns</label><input id="f-max" type="number" min="1" max="60" value="${a.max_turns}" style="width:6rem"></div>
          <div><label for="f-every">Screenshot check (s)</label><input id="f-every" type="number" min="2" max="120" value="${a.capture_every_sec}" style="width:6rem"></div>
        </div>
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-screen" style="width:auto" ${a.require_screen ? "checked" : ""}> Require sharing the entire screen (screenshots)</label>
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-paste" style="width:auto" ${a.allow_paste ? "checked" : ""}> Allow pasting into the chat</label>
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-draw" style="width:auto" ${a.allow_drawing ? "checked" : ""}> Students may answer with a drawing (a Draw button), and the evaluator may ask for one on a blank page</label>
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-code" style="width:auto" ${a.allow_code ? "checked" : ""}> Students may answer with code (a Code button), and the evaluator may ask for code in a blank code area</label>
        <label for="f-code-lang" style="margin-left:1.6rem">Language for blank code areas <span class="muted">(any language CodeMirror knows, e.g. JavaScript, Python, SQL, HTML; empty for plain text)</span></label>
        <input id="f-code-lang" list="languages" value="${esc(a.code_language || "")}" style="max-width:16rem;margin-left:1.6rem">
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-math" style="width:auto" ${a.allow_math ? "checked" : ""}> Students may answer with math (a Math button), and the evaluator may ask for math in a blank math area</label>
        <label class="row" style="font-weight:400"><input type="checkbox" id="f-conf" style="width:auto" ${a.ask_confidence ? "checked" : ""}> Ask how sure students are (1 to 5) with each answer <span class="muted">(never shown to the AIs; not graded)</span></label>
        <label for="f-transfer">New settings to test transfer <span class="muted">(one per line, e.g. "a Node server reading a file"; the interviewer sees these; empty to skip)</span></label>
        <textarea id="f-transfer" rows="3">${esc(a.transfer_settings || "")}</textarea>
        <label for="f-revisit">Revisit weak spots from earlier assessments <span class="muted">(how many, 0 to 4; picked per student from their earlier grades in this course; never counted in this exam's points)</span></label>
        <input id="f-revisit" type="number" min="0" max="4" value="${a.revisit_max || 0}" style="width:6rem">
        <label for="f-hints">Hints a student may ask for <span class="muted">(0 to 5; 0 turns them off. Each hint caps the part it is about one level lower, so on a part with only two levels one hint costs all of it.)</span></label>
        <input id="f-hints" type="number" min="0" max="5" value="${a.hint_limit ?? 2}" style="width:6rem">
      </div>
      <div>
        <label for="f-rubric">Rubric <span class="muted">(JSON; levels best first; points add up per criterion)</span></label>
        <textarea id="f-rubric" class="json" rows="24">${esc(JSON.stringify(a.rubric, null, 2))}</textarea>
        <p class="muted small" id="rubric-total"></p>
      </div>
      <div style="grid-column: 1 / -1">
        <h2>Shapes students can use</h2>
        <p class="muted small">From this course's <a href="#/shapes?course=${esc(a.course || "326")}">shape library</a>. Students find them under Shapes in the drawing pad. ${library.length ? "" : "The library is empty; add the starter set on the Shapes page."}</p>
        <div class="shape-grid" id="f-shapes">${library.map((st) => `<label class="shape-pick">${Sketch.thumb(st)}<span class="small">${esc(st.name)}</span>
          <input type="checkbox" data-stencil="${st.id}" ${offered(st) ? "checked" : ""}></label>`).join("")}</div>
        <h2>Answer areas</h2>
        <p class="muted small">Places students answer in something other than words. The evaluator opens one when it would show understanding better than words, at most once each.
          <strong>Drawings:</strong> students cannot move or erase what you draw; they draw on it and connect arrows to it.
          <strong>Code:</strong> any language; students can change the starter code, and "Start over" puts it back.
          <strong>Math:</strong> students type math (x^2, /, sqrt) and it is typeset; they can change any starter.</p>
        <div id="diagrams"></div>
        <p class="row"><button type="button" id="add-diagram">Add a drawing</button><button type="button" id="add-code">Add a code area</button><button type="button" id="add-math">Add a math area</button></p>
        <datalist id="languages"></datalist>
      </div>
      <div><p class="error" id="a-error"></p><p class="row"><button class="primary">Save</button>
        ${isNew ? "" : '<button type="button" id="check-dl">Download for check</button><button type="button" id="archive" class="danger">Archive</button>'}<span class="muted" id="a-saved"></span></p>
        ${isNew ? "" : '<p class="muted small">Before students see it, run the saved assessment through the pre-flight check: <code>node viva/private/check/check.mjs &lt;file&gt;</code> (see the Viva README).</p>'}</div>
    </form>`;

  const total = () => {
    try {
      const r = JSON.parse($("f-rubric").value);
      const err = checkRubric(r);
      $("rubric-total").textContent = err || `${r.length} criteria, ${r.reduce((s, c) => s + Math.max(...c.levels.map((l) => Number(l.points))), 0)} points in all.`;
    } catch (e) { $("rubric-total").textContent = "Not valid JSON yet: " + e.message; }
  };
  $("f-rubric").addEventListener("input", total);
  total();

  // Answer areas: drawings (each with its own drawing pad), code (a CodeMirror editor for the
  // starter) and math (a MathLive field for the starter). Saved together in assessments.diagrams.
  const pads = [];
  const nextId = (prefix) => `${prefix}${Math.max(0, ...pads.filter((p) => p.id.startsWith(prefix) && /^\d+$/.test(p.id.slice(prefix.length))).map((p) => +p.id.slice(prefix.length))) + 1}`;
  const fillLanguages = async () => {
    if ($("languages").childElementCount) return;
    const { LANGUAGES } = await import("./code.js");
    $("languages").innerHTML = LANGUAGES.map((n) => `<option value="${esc(n)}">`).join("");
  };
  if (a.allow_code) fillLanguages();
  $("f-code").addEventListener("change", fillLanguages);
  const areaHead = (kind, dd) => `<div class="row"><strong>${{ code: "Code area", math: "Math area" }[kind] || "Drawing"} <code>${esc(dd.id)}</code></strong><span class="spacer"></span><button type="button" class="danger" data-remove>Remove</button></div>
      <div class="grid2" style="grid-template-columns:1fr 1fr">
        <div><label>Title <span class="muted">(students see it)</span></label><input data-f="title" value="${esc(dd.title)}"></div>
        <div><label>What students are told <span class="muted">(students and the interviewer see it)</span></label><input data-f="prompt" value="${esc(dd.prompt)}"></div>
      </div>
      <label>When to ask for it <span class="muted">(only the evaluator sees this)</span></label><input data-f="when" value="${esc(dd.when)}">`;
  const addWork = async (kind, d) => {
    const dd = { id: d?.id || nextId(kind), title: d?.title || "", prompt: d?.prompt || "", when: d?.when || "", language: d?.language || "", starter: d?.starter || "" };
    const card = document.createElement("div");
    card.className = "diagram-card";
    card.innerHTML = areaHead(kind, dd) + (kind === "code"
      ? `<label>Language</label><input data-f="language" list="languages" value="${esc(dd.language)}" placeholder="JavaScript" style="max-width:16rem">
         <label>Starter code <span class="muted">(optional; students can change it)</span></label><div data-editor></div>`
      : `<label>Starter math <span class="muted">(optional; students can change it)</span></label><div data-editor></div>`);
    $("diagrams").appendChild(card);
    const entry = { id: dd.id, kind, card, value: () => dd.starter };
    pads.push(entry);
    card.querySelector("[data-remove]").addEventListener("click", () => {
      if (!confirm("Remove this area?")) return;
      card.remove(); pads.splice(pads.indexOf(entry), 1);
    });
    const box = card.querySelector("[data-editor]");
    if (kind === "code") {
      fillLanguages();
      const { CodeBox } = await import("./code.js");
      let editor = new CodeBox(box, { language: dd.language, text: dd.starter, label: "Starter code" });
      entry.value = () => editor.text();
      card.querySelector('[data-f="language"]').addEventListener("change", (ev) => {
        const text = editor.text();
        editor.destroy();
        editor = new CodeBox(box, { language: ev.target.value, text, label: "Starter code" });
      });
    } else {
      const { mathField } = await import("./math.js");
      const mf = mathField(box, { latex: dd.starter, label: "Starter math" });
      entry.value = () => mf.value;
    }
  };
  const addDiagram = (d) => {
    if (d?.kind === "code" || d?.kind === "math") return addWork(d.kind, d);
    const dd = { id: d?.id || nextId("d"), title: d?.title || "", prompt: d?.prompt || "", when: d?.when || "", scene: d?.scene || null };
    const card = document.createElement("div");
    card.className = "diagram-card";
    card.innerHTML = areaHead("drawing", dd) + `<label>Starting diagram</label><div data-pad></div>`;
    $("diagrams").appendChild(card);
    const pad = new Sketch(card.querySelector("[data-pad]"), { scene: dd.scene, authoring: true, stencils: library });
    const entry = { id: dd.id, kind: "drawing", card, pad };
    pads.push(entry);
    card.querySelector("[data-remove]").addEventListener("click", () => {
      if (!confirm("Remove this drawing?")) return;
      card.remove(); pads.splice(pads.indexOf(entry), 1);
    });
  };
  for (const d of a.diagrams || []) addDiagram(d);
  $("add-diagram").addEventListener("click", () => addDiagram(null));
  $("add-code").addEventListener("click", () => addWork("code", null));
  $("add-math").addEventListener("click", () => addWork("math", null));

  // Fill from JSON: puts a file's values into the form; Save works as usual.
  const FIELDS = {
    title: "f-title", course: "f-course", student_intro: "f-intro", opening_question: "f-opening", interviewer_brief: "f-brief",
    answer_key: "f-key", transfer_settings: "f-transfer", time_limit_min: "f-time", min_turns: "f-min", max_turns: "f-max",
    capture_every_sec: "f-every", revisit_max: "f-revisit", hint_limit: "f-hints",
  };
  FIELDS.code_language = "f-code-lang";
  const CHECKS = { require_screen: "f-screen", allow_paste: "f-paste", allow_drawing: "f-draw", ask_confidence: "f-conf", allow_code: "f-code", allow_math: "f-math" };
  const fillFrom = (text) => {
    $("imp-error").textContent = ""; $("imp-msg").textContent = "";
    let got;
    try { got = readAssessment(text); } catch (e) { $("imp-error").textContent = e.message; return; }
    const { values, ignored, notes } = got;
    for (const [k, el] of Object.entries(FIELDS)) if (k in values) $(el).value = values[k];
    for (const [k, el] of Object.entries(CHECKS)) if (k in values) $(el).checked = values[k];
    if (values.rubric) { $("f-rubric").value = JSON.stringify(values.rubric, null, 2); total(); }
    if (values.diagrams) {
      for (const p of pads) p.card.remove();
      pads.length = 0;
      for (const d of values.diagrams) addDiagram(d);
    }
    if (got.resetShapes) v.querySelectorAll("#f-shapes [data-stencil]").forEach((b) => { b.checked = true; });
    const rubricErr = values.rubric ? checkRubric(values.rubric) : null;
    if (rubricErr) notes.unshift("Rubric: " + rubricErr);
    if (ignored.length) notes.push("Not used: " + ignored.join(", ") + ".");
    $("imp-msg").textContent = `Filled ${Object.keys(values).length} fields. Check them, then press Save.` + (notes.length ? " " + notes.join(" ") : "");
  };
  $("imp-fill").addEventListener("click", () => fillFrom($("imp-text").value));
  $("imp-file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const text = await f.text();
    $("imp-text").value = text;
    fillFrom(text);
  });
  const diagramsNow = () => pads.map((p) => {
    const f = (k) => p.card.querySelector(`[data-f="${k}"]`).value.trim();
    if (p.kind === "code") return { id: p.id, kind: "code", title: f("title") || "Code", prompt: f("prompt"), when: f("when"), language: f("language"), starter: p.value() };
    if (p.kind === "math") return { id: p.id, kind: "math", title: f("title") || "Math", prompt: f("prompt"), when: f("when"), starter: p.value() };
    const scene = p.pad.scene();
    scene.items.forEach((i) => { i.locked = true; });
    return { id: p.id, title: f("title") || "Drawing", prompt: f("prompt"), when: f("when"), scene };
  });

  $("a-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("a-error").textContent = ""; $("a-saved").textContent = "";
    let rubric;
    try { rubric = JSON.parse($("f-rubric").value); } catch (e) { $("a-error").textContent = "Rubric is not valid JSON: " + e.message; return; }
    const err = checkRubric(rubric);
    if (err) { $("a-error").textContent = err; return; }
    const row = {
      title: $("f-title").value.trim(), course: $("f-course").value.trim() || "326",
      student_intro: $("f-intro").value, opening_question: $("f-opening").value.trim(),
      interviewer_brief: $("f-brief").value, answer_key: $("f-key").value, rubric,
      time_limit_min: +$("f-time").value, min_turns: +$("f-min").value, max_turns: +$("f-max").value,
      capture_every_sec: +$("f-every").value, require_screen: $("f-screen").checked, allow_paste: $("f-paste").checked,
      allow_drawing: $("f-draw").checked, ask_confidence: $("f-conf").checked, transfer_settings: $("f-transfer").value.trim(),
      revisit_max: Math.max(0, Math.min(4, +$("f-revisit").value || 0)), diagrams: diagramsNow(),
      allow_code: $("f-code").checked, code_language: $("f-code-lang").value.trim(), allow_math: $("f-math").checked,
      hint_limit: Math.max(0, Math.min(5, Math.round(+$("f-hints").value || 0))),
      stencil_ids: (() => {   // null means every shape in the library, including ones added later
        const boxes = [...v.querySelectorAll("#f-shapes [data-stencil]")];
        return boxes.every((b) => b.checked) ? null : boxes.filter((b) => b.checked).map((b) => b.dataset.stencil);
      })(),
      updated_at: new Date().toISOString(),
    };
    try {
      if (isNew) {
        const out = must(await sb.from("assessments").insert(row).select("id").single());
        location.hash = `#/a/${out.id}`;
      } else {
        must(await sb.from("assessments").update(row).eq("id", id));
        $("a-saved").textContent = "Saved.";
      }
    } catch (e) { $("a-error").textContent = e.message; }
  });

  if (!isNew) {
    $("open-session").addEventListener("click", async () => {
      const s = must(await sb.rpc("viva_open_session", { p_assessment: id, p_label: $("session-label").value.trim(), p_roster_only: !$("practice").checked }));
      location.hash = `#/s/${s.id}`;
    });
    $("check-dl").addEventListener("click", () => {
      const keep = ["title", "course", "student_intro", "interviewer_brief", "opening_question", "rubric", "answer_key",
                    "time_limit_min", "min_turns", "max_turns", "require_screen", "allow_paste", "capture_every_sec",
                    "diagrams", "allow_drawing", "ask_confidence", "transfer_settings", "revisit_max", "hint_limit",
                    "allow_code", "code_language", "allow_math"];
      download(`viva-${a.title.replace(/\W+/g, "-").toLowerCase()}.json`, JSON.stringify(Object.fromEntries(keep.map((k) => [k, a[k]])), null, 2) + "\n", "application/json");
    });
    $("archive").addEventListener("click", async () => {
      if (!confirm("Archive this assessment? Its sessions and records stay.")) return;
      must(await sb.from("assessments").update({ archived: true }).eq("id", id));
      location.hash = "#/";
    });
  }
}

// ---------------------------------------------------------------- roster

export function parseRoster(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const split = (l) => {
    const out = []; let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if ((ch === "," || ch === "\t") && !q) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const rows = [];
  if (head.includes("sis login id") || head.includes("student")) {
    // Canvas gradebook export: Student ("Last, First"), ID, SIS User ID, SIS Login ID, Section, ...
    const iName = head.indexOf("student"), iLogin = head.indexOf("sis login id"), iSec = head.indexOf("section");
    const iEmail = head.findIndex((h) => h.includes("email"));
    for (const l of lines.slice(1)) {
      const c = split(l);
      const raw = (iEmail >= 0 && c[iEmail]) || c[iLogin] || "";
      if (!raw || /points possible/i.test(c[iName] || "") || /^(test student|student,\s*test)$/i.test((c[iName] || "").trim())) continue;
      const email = (raw.includes("@") ? raw : `${raw}@umass.edu`).toLowerCase();
      const n = c[iName] || "";
      const name = n.includes(",") ? n.split(",").slice(1).join(",").trim() + " " + n.split(",")[0].trim() : n;
      rows.push({ email, name, section: iSec >= 0 ? (c[iSec] || "") : "" });
    }
  } else {
    for (const l of lines) {
      const c = split(l);
      const ei = c.findIndex((x) => x.includes("@"));
      if (ei < 0) continue;
      const rest = c.filter((_, i) => i !== ei);
      rows.push({ email: c[ei].toLowerCase(), name: rest[0] || "", section: rest[1] || "" });
    }
  }
  return rows;
}

async function roster() {
  const v = view();
  const course = new URLSearchParams(location.hash.split("?")[1] || "").get("course") || "326";
  const rows = must(await sb.from("roster").select("*").eq("course", course).order("name"));
  v.innerHTML = `
    <h1>Roster: ${esc(course)}</h1>
    <p class="muted">Students join with an email on this list. Paste a Canvas gradebook export (CSV), or lines of <code>email, name, section</code>. Existing emails are updated, none are removed.</p>
    <textarea id="r-paste" rows="8" placeholder="ana@umass.edu, Ana Alvarez, 01"></textarea>
    <p class="row"><button class="primary" id="r-add">Add to roster</button><span class="muted" id="r-msg"></span></p>
    <p class="error" id="r-error"></p>
    <h2>${rows.length} students</h2>
    <table><thead><tr><th>Name</th><th>Email</th><th>Section</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td>${esc(r.section)}</td>
        <td><button class="danger small" data-del="${esc(r.email)}">Remove</button></td></tr>`).join("")}
    </tbody></table>`;
  $("r-add").addEventListener("click", async () => {
    $("r-error").textContent = "";
    const parsed = parseRoster($("r-paste").value).map((r) => ({ ...r, course }));
    if (!parsed.length) { $("r-error").textContent = "No emails found in that text."; return; }
    try {
      must(await sb.from("roster").upsert(parsed, { onConflict: "course,email" }));
      route();
    } catch (e) { $("r-error").textContent = e.message; }
  });
  v.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    if (!confirm(`Remove ${b.dataset.del} from the roster?`)) return;
    must(await sb.from("roster").delete().eq("course", course).eq("email", b.dataset.del));
    route();
  }));
}

// ---------------------------------------------------------------- the shape library

async function shapes() {
  const v = view();
  const course = new URLSearchParams(location.hash.split("?")[1] || "").get("course") || "326";
  const list = must(await sb.from("stencils").select("*").eq("course", course).eq("archived", false).order("sort").order("created_at"));
  v.innerHTML = `
    <div class="row"><h1>Shapes: ${esc(course)}</h1><span class="spacer"></span>
      ${list.length ? "" : `<button class="primary" id="sh-starter">Add the starter set (${STARTER.length} shapes)</button>`}
      <button id="sh-new">New shape</button></div>
    <p class="muted">Ready-made shapes students place in their drawings, such as a database or an Express server. Each one moves, resizes and takes a label as one piece, arrows attach to it, and the AIs read it by name ("Database shape"). Draw a shape with the pad; its size and position do not matter, only the drawing. Changing a shape here never changes drawings already made. Each assessment chooses which shapes it offers.</p>
    <div class="shape-grid" style="grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))">${list.map((st) =>
      `<button type="button" class="shape-pick" data-edit="${st.id}">${Sketch.thumb(st)}<span>${esc(st.name)}</span></button>`).join("") || '<p class="muted">No shapes yet.</p>'}</div>
    <div id="sh-editor"></div>`;
  $("sh-starter")?.addEventListener("click", async () => {
    must(await sb.from("stencils").insert(STARTER.map((st, i) => ({ course, name: st.name, scene: st.scene, sort: i }))));
    route();
  });
  const open = (st) => {
    const ed = $("sh-editor");
    ed.innerHTML = `<div class="diagram-card" style="margin-top:1rem">
      <div class="row"><h2 style="margin:0">${st ? "Edit shape" : "New shape"}</h2><span class="spacer"></span>
        ${st ? '<button type="button" class="danger" id="sh-archive">Remove from the library</button>' : ""}</div>
      <label for="sh-name">Name <span class="muted">(what students and the AIs call it)</span></label>
      <input id="sh-name" value="${esc(st?.name || "")}" placeholder="Redis cache" style="max-width:20rem">
      <label>Drawing</label><div id="sh-pad"></div>
      <p class="row"><button class="primary" id="sh-save">Save shape</button><span class="muted" id="sh-msg"></span></p>
      <p class="error" id="sh-error"></p></div>`;
    // Shown in the middle of the pad at its own size.
    const scene = st ? { items: st.scene.items.map((it) => {
      const dx = 300, dy = 150, c = structuredClone(it);
      if (c.type === "path") c.points = c.points.map(([x, y]) => [x + dx, y + dy]);
      else if (c.type === "arrow") { for (const e of ["from", "to"]) if (c[e]?.x != null) c[e] = { x: c[e].x + dx, y: c[e].y + dy }; }
      else { c.x += dx; c.y += dy; }
      return c;
    }) } : null;
    const pad = new Sketch($("sh-pad"), { scene, authoring: true });
    ed.scrollIntoView({ behavior: "smooth", block: "start" });
    $("sh-save").addEventListener("click", async () => {
      $("sh-error").textContent = "";
      const name = $("sh-name").value.trim();
      const items = pad.scene().items.filter((i) => i.type !== "stencil");
      if (!name) { $("sh-error").textContent = "Give the shape a name."; return; }
      if (!items.length) { $("sh-error").textContent = "Draw the shape first."; return; }
      const row = { name, scene: normalize(items) };
      try {
        if (st) must(await sb.from("stencils").update(row).eq("id", st.id));
        else must(await sb.from("stencils").insert({ ...row, course, sort: list.length }));
        route();
      } catch (e) { $("sh-error").textContent = e.message; }
    });
    $("sh-archive")?.addEventListener("click", async () => {
      if (!confirm(`Remove "${st.name}" from the library? Drawings that already use it keep it.`)) return;
      must(await sb.from("stencils").update({ archived: true }).eq("id", st.id));
      route();
    });
  };
  $("sh-new").addEventListener("click", () => open(null));
  v.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => open(list.find((x) => x.id === b.dataset.edit))));
}

// ---------------------------------------------------------------- a session: live monitor

async function sessionPage(id) {
  const v = view();
  const s = must(await sb.from("sessions").select("*").eq("id", id).single());
  const a = must(await sb.from("assessments").select("id,title,course").eq("id", s.assessment_id).single());
  v.innerHTML = `
    <div class="row"><h1>${esc(a.title)}</h1><span class="spacer"></span>
      <a class="btn" href="#/p/${s.id}">Projector</a>
      <button id="s-toggle">${s.status === "open" ? "Close session" : "Reopen session"}</button>
      <button id="s-csv">Export grades (CSV)</button></div>
    <p>Code <code style="font-size:1.3rem">${esc(s.code)}</code> · ${esc(s.label)} · <span>${s.status}</span>${s.roster_only ? "" : ' · <span class="pill">practice</span>'}
      · <a href="${esc(studentUrl(s.code))}" target="_blank" rel="noopener">${esc(studentUrl(s.code))}</a></p>
    <p class="muted small" id="s-summary"></p>
    <table><thead><tr><th>Student</th><th>Status</th><th class="num">Turns</th><th class="num">Time left</th>
      <th class="num">Times away</th><th class="num">Away total</th><th>Screen</th><th class="num">Shots</th><th class="num">Pastes</th>
      <th class="num">Drawings</th><th class="num">Hints</th><th class="num">Sure</th>
      <th class="num">Suggested</th><th class="num">Final</th><th></th></tr></thead><tbody id="s-rows"></tbody></table>`;
  $("s-toggle").addEventListener("click", async () => {
    must(await sb.from("sessions").update(s.status === "open" ? { status: "closed", closed_at: new Date().toISOString() } : { status: "open", closed_at: null }).eq("id", id));
    route();
  });
  let latest = [];
  $("s-csv").addEventListener("click", () => {
    const cols = ["email", "name", "section", "status", "end_reason", "turns", "away_count", "away_seconds", "paste_blocked", "screen_ended", "joins", "suggested_points", "max_points", "final_points", "approved",
                  "avg_confidence", "drawings", "transfer", "revisited", "revisit_better", "hints"];
    const lines = [cols.join(",")].concat(latest.map((t) => [t.email, t.name, t.section, t.status, t.end_reason, t.turns, t.away_count,
      Math.round(t.away_ms / 1000), t.paste_blocked, t.screen_ended, t.joins, t.suggested_points, t.max_points, t.final_points, t.approved_at ? "yes" : "",
      t.avg_confidence != null ? Number(t.avg_confidence).toFixed(1) : "", t.drawings, t.transfer_status, t.revisit_count, t.revisit_better, t.hints].map(csvCell).join(",")));
    download(`viva-${s.code}-${a.title.replace(/\W+/g, "-").toLowerCase()}.csv`, lines.join("\n") + "\n");
  });
  const draw = async () => {
    const rows = must(await sb.from("attempt_overview").select("*").eq("session_id", id).order("name"));
    latest = rows;
    const active = rows.filter((t) => t.status === "active").length;
    const awayNow = rows.filter((t) => t.away_now && t.status === "active").length;
    $("s-summary").textContent = `${rows.length} joined · ${active} in progress · ${rows.length - active} finished · ${awayNow} away right now · updated ${fmtTime(new Date().toISOString())}`;
    $("s-rows").innerHTML = rows.map((t) => {
      const left = t.status === "active" ? Math.max(0, Date.parse(t.deadline_at) - Date.now()) : 0;
      const flag = (t.away_now && t.status === "active") || t.screen === "ended" || t.screen === "other";
      return `<tr class="${flag ? "flag" : ""}">
        <td>${esc(t.name || t.email)}<br><span class="muted small">${esc(t.email)}</span></td>
        <td>${t.status === "active" ? (t.away_now ? '<span class="pill away">away now</span>' : '<span class="pill">active</span>') : `<span class="pill done">finished</span> <span class="muted small">${esc(t.end_reason || "")}</span>`}</td>
        <td class="num">${t.turns}</td><td class="num">${t.status === "active" ? secs(left) : ""}</td>
        <td class="num">${t.away_count}</td><td class="num">${secs(t.away_ms)}</td>
        <td>${esc(t.screen)}${t.screen_ended ? ` <span class="muted small">(stopped ${t.screen_ended}×)</span>` : ""}</td>
        <td class="num">${t.captures}</td><td class="num">${t.paste_blocked || ""}</td>
        <td class="num">${t.drawings || ""}</td><td class="num">${t.hints || ""}</td><td class="num">${t.avg_confidence != null ? Number(t.avg_confidence).toFixed(1) : ""}</td>
        <td class="num">${t.suggested_points ?? ""}${t.max_points != null ? " / " + t.max_points : ""}</td>
        <td class="num">${t.final_points ?? ""}${t.approved_at ? " ✓" : ""}</td>
        <td><a href="#/t/${t.id}">Review</a></td></tr>`;
    }).join("") || '<tr><td colspan="15" class="muted">No one has joined yet.</td></tr>';
  };
  await draw();
  if (v.isConnected) poll = setInterval(() => draw().catch(() => {}), 4000);
}

async function projector(id) {
  const v = view();
  const s = must(await sb.from("sessions").select("*").eq("id", id).single());
  const a = must(await sb.from("assessments").select("title").eq("id", s.assessment_id).single());
  const url = studentUrl(s.code);
  v.innerHTML = `<div class="projector">
    <h1 style="font-size:3rem">${esc(a.title)}</h1>
    <div class="code-big">${esc(s.code)}</div>
    <p class="url">${esc(url.replace(/^https?:\/\//, "").replace(/\?.*$/, ""))}</p>
    <div style="width:16rem;margin:1rem auto">${qrSvg(url)}</div>
    <p style="font-size:1.4rem">Use a laptop. Join with your UMass email, then share your <strong>entire screen</strong>.</p>
    <p><a href="#/s/${s.id}">Back to the monitor</a></p></div>`;
}

// ---------------------------------------------------------------- review one attempt

async function review(id) {
  const v = view();
  const t = must(await sb.from("attempt_overview").select("*").eq("id", id).single());
  const [msgs, events, shots, evals, gradeRows, a, siblings] = await Promise.all([
    sb.from("messages").select("*").eq("attempt_id", id).order("id"),
    sb.from("focus_events").select("*").eq("attempt_id", id).order("id"),
    sb.from("captures").select("*").eq("attempt_id", id).order("taken_at"),
    sb.from("evaluations").select("*").eq("attempt_id", id).order("id"),
    sb.from("grades").select("*").eq("attempt_id", id),
    sb.from("assessments").select("title,rubric").eq("id", t.assessment_id).single(),
    sb.from("attempt_overview").select("id,name,email").eq("session_id", t.session_id).order("name"),
  ]).then((rs) => rs.map(must));
  const grade = gradeRows[0] || null;
  const final = evals.filter((e) => e.final).at(-1) || evals.at(-1) || null;
  const idx = siblings.findIndex((x) => x.id === id);
  const prev = siblings[idx - 1], next = siblings[idx + 1];

  const drawPaths = msgs.map((m) => m.meta?.drawing?.path).filter(Boolean);
  const paths = [...shots.map((c) => c.path), ...drawPaths];
  const signed = paths.length ? must(await sb.storage.from("captures").createSignedUrls(paths, 3600)) : [];
  const urls = Object.fromEntries(signed.map((x) => [x.path, x.signedUrl]));

  // Each student answer's confidence next to how the evaluator judged that answer on its own.
  const judged = new Map(evals.filter((e) => !e.final).map((e) => [e.after_turn, e.result.last_answer]));
  const answers = [];
  const works = [];   // code and math answers, drawn after the page is built
  let turn = 0;
  const transcript = msgs.map((m) => {
    let extra = "";
    if (m.role === "student") {
      turn++;
      const conf = m.meta?.confidence, j = judged.get(turn);
      if (conf || j) answers.push({ turn, conf, j });
      const over = conf >= 4 && (j === "wrong" || j === "no_answer"), under = conf && conf <= 2 && j === "correct";
      const bits = [m.meta?.pasted ? `pasted ${m.meta.pasted} chars` : "", m.meta?.typed_ms != null && m.content ? `typed over ${secs(m.meta.typed_ms)}` : ""].filter(Boolean).join(" · ");
      extra = (m.meta?.drawing ? `<span class="sketch-view">${Sketch.svg(m.meta.drawing.scene || { items: [] })}</span>
          <div class="small" style="opacity:.85">drawing${m.meta.drawing.diagram ? ` (${esc(m.meta.drawing.diagram)})` : ""} · <a style="color:inherit" href="${esc(urls[m.meta.drawing.path] || "#")}" target="_blank" rel="noopener">image sent to the AI</a></div>` : "") +
        `<div class="small" style="opacity:.85">${bits}${conf ? `${bits ? " · " : ""}<span class="pill ${over ? "over" : under ? "under" : ""}" title="How sure the student said they were">sure ${conf}/5</span>` : ""}${j ? ` <span class="pill" title="The evaluator's judgment of this answer alone">answer: ${esc(j.replace("_", " "))}</span>` : ""}</div>`;
      if (m.meta?.code || m.meta?.math) {
        const w = m.meta.code || m.meta.math;
        const notes = [m.meta.code ? `code${w.language ? ` (${esc(w.language)})` : ""}` : "math", w.area && !String(w.area).startsWith("free") ? `area ${esc(w.area)}` : "",
          w.starter ? (w.changed ? "changed the starter" : "<strong>starter unchanged</strong>") : "", w.resets ? `started over ${w.resets}×` : ""].filter(Boolean).join(" · ");
        extra += `<div class="work ${m.meta.code ? "code" : "math"}" data-work="${works.length}"></div><span class="work-tag">${notes}${w.starter ? ` · <a href="#" data-starter="${works.length}" style="color:inherit">show the starter</a>` : ""}</span>`;
        works.push(m.meta.code ? { kind: "code", language: w.language, text: w.text, starter: w.starter } : { kind: "math", text: w.latex, starter: w.starter });
      }
    } else if (m.role === "helper") {
      extra = `<div class="small" style="opacity:.85">hint ${m.meta?.nth > 1 ? `${m.meta.nth} ` : ""}on ${esc(m.meta?.criterion_name || m.meta?.criterion || "")} · caps it at ${esc(m.meta?.cap_level || "")} (up to ${m.meta?.cost ?? "?"} point${m.meta?.cost === 1 ? "" : "s"})</div>`;
    } else if (m.meta?.diagram) {
      extra = `<span class="asked">Opened ${({ code: "code", math: "math" })[m.meta.diagram.kind] || "drawing"} area: ${esc(m.meta.diagram.title)}</span>`;
    }
    return `<div class="msg ${m.role}"><div class="small" style="opacity:.7">${fmtTime(m.created_at)}</div>${m.role === "helper" ? "Hint: " : ""}${esc(m.content)}${extra}</div>`;
  }).join("");

  const worth = { correct: 1, partly: 0.5, wrong: 0, no_answer: 0 };
  const paired = answers.filter((x) => x.conf && x.j);
  const calib = paired.length ? (() => {
    const avgConf = paired.reduce((s, x) => s + x.conf, 0) / paired.length;
    const right = paired.reduce((s, x) => s + worth[x.j], 0) / paired.length;
    const gap = paired.reduce((s, x) => s + (x.conf - 1) / 4 - worth[x.j], 0) / paired.length;
    const over = paired.filter((x) => x.conf >= 4 && worth[x.j] === 0).length, under = paired.filter((x) => x.conf <= 2 && x.j === "correct").length;
    return `<h2>Confidence</h2><div class="card">
      <p style="margin-top:0">Average ${avgConf.toFixed(1)} / 5 sure; answers judged ${Math.round(right * 100)}% right. <strong>${Math.abs(gap) < 0.15 ? "Well calibrated" : gap > 0 ? "Overconfident" : "Underconfident"}</strong>
        <span class="muted small">(gap ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}: confidence scaled 0 to 1, minus the share right)</span></p>
      <p class="small muted">${over} answer${over === 1 ? "" : "s"} sure (4 or 5) but wrong · ${under} sure at most 2 but right.</p>
      <table class="calib"><thead><tr><th>Turn</th><th class="num">Sure</th><th>Answer</th></tr></thead><tbody>
        ${answers.map((x) => `<tr><td>${x.turn}</td><td class="num">${x.conf ?? ""}</td><td>${esc((x.j || "").replace("_", " "))}</td></tr>`).join("")}
      </tbody></table></div>`;
  })() : "";

  const tr = final?.result.transfer;
  const transfer = tr ? `<h2>New setting (transfer)</h2><div class="card"><strong>${esc({ not_asked: "Not asked", shown: "Shown", partly: "Partly", not_shown: "Not shown" }[tr.status] || tr.status)}</strong>
      <div class="muted small">${esc(tr.evidence)}</div></div>` : "";
  const rv = final?.result.revisit || [];
  const revisit = rv.length ? `<h2>Earlier weak spots revisited</h2><p class="muted small">Not counted in this exam's points.</p>
    <table><thead><tr><th>From</th><th>Criterion</th><th>Earlier</th><th>Now</th><th></th></tr></thead><tbody>
      ${rv.map((r) => `<tr class="${r.change === "worse" ? "flag" : ""}"><td>${esc(r.assessment_title)}</td><td>${esc(r.name)}<div class="muted small">${esc(r.evidence)}</div></td>
        <td>${esc(r.earlier_level)}</td><td>${esc(r.level)}${r.prompted ? ' <span class="pill away">prompted</span>' : ""}</td><td>${esc(r.change)}</td></tr>`).join("")}
    </tbody></table>` : "";

  const crit = final ? final.result.criteria.map((c) => `<div class="crit"><strong>${esc(c.name)}</strong>: ${esc(c.level)} (${c.points}/${c.max})
      ${c.prompted ? '<span class="pill away">prompted</span>' : ""}${c.hints ? ` <span class="pill over">${c.hints} hint${c.hints === 1 ? "" : "s"}${c.capped_from ? `, capped from ${esc(c.capped_from)}` : ""}</span>` : ""}<div class="muted small">${esc(c.evidence)}</div></div>`).join("") : '<p class="muted">No evaluation yet.</p>';

  v.innerHTML = `
    <div class="row"><a href="#/s/${t.session_id}">← Session</a><span class="spacer"></span>
      ${prev ? `<a class="btn" href="#/t/${prev.id}">← ${esc(prev.name || prev.email)}</a>` : ""}
      ${next ? `<a class="btn" href="#/t/${next.id}">${esc(next.name || next.email)} →</a>` : ""}</div>
    <h1>${esc(t.name || t.email)} <span class="muted small">${esc(t.email)}</span></h1>
    <p class="muted">${esc(a.title)} · ${t.status}${t.end_reason ? ` (${esc(t.end_reason)})` : ""} · started ${fmtDate(t.started_at)}${t.finished_at ? ` · finished ${fmtTime(t.finished_at)}` : ""}
      · ${t.turns} turns · <strong>away ${t.away_count}× for ${secs(t.away_ms)}</strong> · screen: ${esc(t.screen)} · joined ${t.joins}×</p>
    <div class="grid2">
      <section><h2>Conversation</h2><div class="log" style="padding:0">${transcript}</div></section>
      <section>
        <h2>Grade</h2>
        <div class="card">
          <p style="margin-top:0"><strong>Suggested: ${final ? `${final.result.points} / ${final.result.max_points}` : "none"}</strong>${final && !final.final ? ' <span class="muted small">(from the latest turn; no final evaluation)</span>' : ""}</p>
          ${final?.usage?.regrade ? `<p class="muted small">Graded again ${fmtDate(final.created_at)} by ${esc(final.usage.by || "")}${final.result.instructor_note ? `, with this note: “${esc(final.result.instructor_note)}”` : ""}</p>` : ""}
          ${final?.result.summary ? `<p>${esc(final.result.summary)}</p>` : ""}
          ${crit}
          <label for="g-final">Final points</label>
          <input id="g-final" type="number" step="0.5" value="${grade?.final_points ?? (final ? final.result.points : "")}" style="max-width:8rem">
          <label for="g-notes">Notes <span class="muted">(yours; not shown to the student)</span></label>
          <textarea id="g-notes" rows="3">${esc(grade?.notes || "")}</textarea>
          <p class="row"><button class="primary" id="g-save">${grade?.approved_at ? "Update approval" : "Approve grade"}</button>
            <span class="muted small" id="g-msg">${grade?.approved_at ? `Approved ${fmtDate(grade.approved_at)} by ${esc(grade.approved_by)}` : ""}</span></p>
          <p class="error" id="g-error"></p>
        </div>
        ${t.status === "finished" && t.turns > 0 ? `<details class="card" id="rg"${final ? "" : " open"}>
          <summary><strong>Grade again</strong> <span class="muted small">${final ? "the AI grader reads the whole conversation again" : "this conversation has no grade yet"}</span></summary>
          <label for="rg-note">Note for the grader <span class="muted">(optional; for example “count the answer about hx-target as Met”)</span></label>
          <textarea id="rg-note" rows="3"></textarea>
          <p class="row"><button id="rg-go">Grade again</button><span class="muted small" id="rg-msg">Takes up to a minute. Your approved final points stay as they are.</span></p>
          <p class="error" id="rg-error"></p>
        </details>` : ""}
        ${transfer}${revisit}${calib}
        <h2>Leaving the conversation</h2>
        <table><thead><tr><th>What</th><th>When</th><th class="num">How long</th><th>Detail</th></tr></thead><tbody>
          ${events.map((e) => `<tr class="${e.kind === "away" && e.duration_ms > 10000 ? "flag" : ""}"><td>${esc(e.kind.replace("_", " "))}</td><td>${fmtTime(e.started_at)}</td>
            <td class="num">${e.kind === "away" ? (e.duration_ms != null ? secs(e.duration_ms) : "still away") : ""}</td>
            <td class="small muted">${esc(Object.entries(e.detail || {}).map(([k, v]) => `${k}: ${v}`).join(", "))}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Never left.</td></tr>'}
        </tbody></table>
        <h2>Screenshots (${shots.length})</h2>
        <p class="muted small">Red border: taken while away or just after leaving.</p>
        <div class="shots">${shots.map((c, i) => `<figure class="${c.reason}" data-i="${i}"><img loading="lazy" src="${esc(urls[c.path] || "")}" alt="Screenshot ${fmtTime(c.taken_at)}">
          <figcaption>${fmtTime(c.taken_at)} · ${esc(c.reason)}</figcaption></figure>`).join("") || '<p class="muted">None.</p>'}</div>
      </section>
    </div>`;

  if (works.length) {
    const needCode = works.some((w) => w.kind === "code"), needMath = works.some((w) => w.kind === "math");
    const [{ CodeBox }, { mathHTML }] = await Promise.all([needCode ? import("./code.js") : {}, needMath ? import("./math.js") : {}]);
    const draw = (el, w, text) => { if (w.kind === "code") new CodeBox(el, { language: w.language, text, readOnly: true }); else el.innerHTML = mathHTML(text); };
    v.querySelectorAll("[data-work]").forEach((el) => draw(el, works[+el.dataset.work], works[+el.dataset.work].text));
    v.querySelectorAll("[data-starter]").forEach((a) => a.addEventListener("click", (ev) => {
      ev.preventDefault();
      const w = works[+a.dataset.starter];
      const el = document.createElement("div");
      el.className = `work ${w.kind}`;
      a.parentElement.after(el);
      draw(el, w, w.starter);
      a.replaceWith(document.createTextNode("starter shown below"));
    }));
  }

  $("g-save").addEventListener("click", async () => {
    $("g-error").textContent = "";
    const v = $("g-final").value === "" ? null : Number($("g-final").value);
    try {
      must(await sb.from("grades").upsert({ attempt_id: id, final_points: v, notes: $("g-notes").value,
        approved_at: new Date().toISOString(), approved_by: me,
        suggested_points: grade?.suggested_points ?? final?.result.points ?? null, max_points: grade?.max_points ?? final?.result.max_points ?? null }));
      $("g-msg").textContent = `Approved just now by ${me}`;
    } catch (e) { $("g-error").textContent = e.message; }
  });

  $("rg-go")?.addEventListener("click", async () => {
    const btn = $("rg-go");
    $("rg-error").textContent = "";
    btn.disabled = true;
    $("rg-msg").textContent = "Grading… this takes up to a minute.";
    try {
      const { data } = await sb.auth.getSession();
      const r = await fetch(`${cfg.supabaseUrl.replace(/\/$/, "")}/functions/v1/viva`, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${data.session?.access_token || ""}` },
        body: JSON.stringify({ action: "regrade", attempt: id, note: $("rg-note").value }),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `The grader failed (${r.status}).`);
      if (location.hash === `#/t/${id}`) review(id);
    } catch (e) {
      $("rg-error").textContent = e.message;
      $("rg-msg").textContent = "";
      btn.disabled = false;
    }
  });

  let at = 0;
  const open = (i) => {
    at = (i + shots.length) % shots.length;
    const c = shots[at];
    $("viewer-img").src = urls[c.path] || "";
    $("viewer-cap").textContent = `${at + 1} of ${shots.length} · ${fmtTime(c.taken_at)} · ${c.reason}`;
    show("viewer");
  };
  v.querySelectorAll(".shots figure").forEach((f) => f.addEventListener("click", () => open(+f.dataset.i)));
  $("viewer-close").onclick = () => show("viewer", false);
  $("viewer-prev").onclick = () => open(at - 1);
  $("viewer-next").onclick = () => open(at + 1);
}

document.addEventListener("keydown", (e) => {
  if ($("viewer").classList.contains("hidden")) return;
  if (e.key === "Escape") show("viewer", false);
  if (e.key === "ArrowLeft") $("viewer-prev").click();
  if (e.key === "ArrowRight") $("viewer-next").click();
});

boot();
