// app.js: the container simulator's screens.
//
// Home: what this is and the activity cards. An activity: a guide of numbered steps on the
// left (do this, watch for this, here's what it meant), and the stage on the right: the
// picture of the laptop (or the files, when a step needs an edit) above a terminal.
// The engine answers each command at once; the terminal plays the answer back as a real
// one would, and the picture marks what the command changed.

import { newWorld, run, setFile, check, replay, ENGINE_VERSION } from "./engine.js";
import { parseYaml } from "./yaml.js";
import { ACTIVITIES, activityById } from "./activities.js";
import { draw, narrate } from "./view.js";
import * as store from "./store.js";
import { startTour, maybeTour } from "./tour.js";

const $ = (id) => document.getElementById(id);
const state = store.load();
let activity = null, world = null, prevWorld = null, lastEvents = [], lastNarration = [];
let history = [], hpos = 0, openFile = null, running = false, skip = false, pendingAsk = null;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- home ----------

function showHome() {
  activity = null;
  state.current = null;
  persist();
  $("lesson").hidden = true;
  $("home").hidden = false;
  const units = [...new Set(ACTIVITIES.map((a) => a.unit))];
  $("cards").innerHTML = units.map((u) => `
    <section class="unit-group"><h2>Unit ${u}: ${u === "02" ? "Docker from Zero" : "Compose, with PostGIS"}</h2>
      <ul class="cards">${ACTIVITIES.filter((a) => a.unit === u).map(card).join("")}</ul></section>`).join("");
  $("work-home").innerHTML = workPanel();
  wireWork($("work-home"));
  window.scrollTo(0, 0);
}

function card(a) {
  const st = state.activities[a.id];
  const done = st ? a.goals.filter((g) => st.goals[g.id]).length : 0;
  const status = st?.reached ? "Done" : st && st.log.length ? "In progress" : "Not started";
  const btn = st?.reached ? "Review" : st && st.log.length ? "Continue" : "Start";
  return `<li class="card ${st?.reached ? "is-done" : ""}">
    <h3>${esc(a.title)}</h3>
    <p>${esc(a.summary || a.intro)}</p>
    <div class="card-foot">
      <span class="pill">${status}</span>
      <span class="q">${a.steps.length} steps · about ${a.minutes} min · ${done} of ${a.goals.length} goals</span>
      <button type="button" data-open="${a.id}">${btn}</button>
    </div></li>`;
}

// ---------- an activity ----------

function openActivity(id) {
  activity = activityById(id);
  state.current = id;
  const a = store.activityState(state, id);
  a.step = a.step ?? 0;
  a.read = a.read || [];
  world = replay(newWorld(activity.files()), a.log);
  prevWorld = world; lastEvents = []; lastNarration = [];
  $("home").hidden = true;
  $("lesson").hidden = false;
  $("l-unit").textContent = `Unit ${activity.unit}`;
  $("l-title").textContent = activity.title;
  $("term-out").textContent = "";
  print(`# ${activity.title}: follow the steps on the left.`, "note");
  const step = activity.steps[a.step];
  openFile = step?.open || Object.keys(world.host.files).find((p) => p.endsWith("Dockerfile")) || ".env";
  showTab("picture");
  renderLesson();
  persist();
  window.scrollTo(0, 0);
  maybeTour();
}

function stepDone(step, i, a) {
  const d = step.done || {};
  if (d.read) return a.read.includes(i);
  if (d.goal) return !!a.goals[d.goal] || check(world, activity.goals.find((g) => g.id === d.goal).check);
  if (d.ran) return a.log.some((e) => e.kind === "cmd" && new RegExp(d.ran).test(e.text));
  if (d.insert) return world.facts.some((f) => f.type === "insert");
  if (d.edited) {
    const now = world.host.files[d.edited.path] || "";
    if (d.edited.changed) return now !== activity.files()[d.edited.path];
    return now.includes(d.edited.contains);
  }
  return false;
}

function renderLesson() {
  const a = store.activityState(state, activity.id);
  // Goals: once reached, a goal stays reached (the grader replays the log to check).
  for (const g of activity.goals) if (check(world, g.check)) a.goals[g.id] = true;
  const goalsDone = activity.goals.filter((g) => a.goals[g.id]).length;
  if (goalsDone === activity.goals.length && !a.reached) a.reached = true;
  $("l-progress").innerHTML = `Step ${Math.min(a.step + 1, activity.steps.length)} of ${activity.steps.length} · ${goalsDone} of ${activity.goals.length} goals`;
  $("goals").innerHTML = activity.goals.map((g) => `<li class="${a.goals[g.id] ? "done" : ""}"><span aria-hidden="true">${a.goals[g.id] ? "✓" : "○"}</span> ${esc(g.text)}</li>`).join("");

  $("steps").innerHTML = activity.steps.map((s, i) => {
    const done = stepDone(s, i, a);
    const cls = i === a.step ? "current" : i < a.step ? "past" : "future";
    const head = `<button type="button" class="step-head" data-goto="${i}" aria-expanded="${i === a.step}">
      <span class="num ${done ? "ok" : ""}">${done ? "✓" : i + 1}</span><span class="step-title">${esc(s.title)}</span></button>`;
    if (i !== a.step) return `<li class="step ${cls}">${head}</li>`;
    const edit = s.edit ? `<button type="button" class="quiet" id="step-edit">${esc(s.edit.label)}</button>` : "";
    const open = s.open && !s.cmd ? `<button type="button" class="quiet" id="step-open">Open ${esc(s.open.split("/").at(-1))}</button>` : "";
    const cmd = s.cmd ? `<div class="cmd-box"><code>${esc(s.cmd)}</code><button type="button" id="step-run" class="run">Run it</button></div>` : "";
    const happened = done && s.after ? `<div class="after"><h4>What happened</h4>${lastNarration.length ? `<ul>${lastNarration.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}<p>${esc(s.after)}</p></div>` : "";
    const isLast = i === activity.steps.length - 1;
    const nextLabel = s.done?.read ? "I've read it, next" : done ? (isLast ? "Finish" : "Next step") : "Skip this step";
    return `<li class="step current">${head}
      <div class="step-body">
        <p>${esc(s.text)}</p>
        ${cmd}${open}${edit}
        <div id="ask-slot"></div>
        <p class="watch"><span class="watch-label">Watch</span> ${esc(s.watch)}</p>
        ${happened}
        <p class="step-nav"><button type="button" id="step-next" class="${done || s.done?.read ? "" : "quiet"}">${nextLabel}</button></p>
      </div></li>`;
  }).join("");

  const finished = a.step >= activity.steps.length;
  $("finished").hidden = !finished;
  if (finished) {
    $("finished").innerHTML = `<h3>${a.reached ? "All goals done" : "Steps finished"}</h3>
      <p>${a.reached ? "Now do the same on your own Docker:" : `${goalsDone} of ${activity.goals.length} goals done: open "All goals" below to see what's left.`}</p>
      ${a.reached ? `<pre>${esc(activity.forReal.join("\n"))}</pre>` : ""}
      <p><button type="button" id="to-home">Back to all activities</button> <button type="button" class="quiet" id="open-work">Export my work</button></p>`;
  }
  $("hint-count").textContent = `(${a.hintsUsed} of ${activity.hints.length} hints used)`;
  $("hints").innerHTML = activity.hints.slice(0, a.hintsUsed).map((h) => `<li>${esc(h)}</li>`).join("");
  $("hint-btn").disabled = a.hintsUsed >= activity.hints.length;

  draw($("world"), world, lastEvents, prevWorld);
  renderFiles();
  wireSteps();
}

function wireSteps() {
  const a = store.activityState(state, activity.id);
  const s = activity.steps[a.step];
  $("steps").querySelectorAll("[data-goto]").forEach((b) => b.onclick = () => {
    a.step = Number(b.dataset.goto); lastNarration = []; persist(); renderLesson();
    const st = activity.steps[a.step];
    if (st.open) { openFile = st.open; if (!st.cmd) showTab("files"); }
  });
  if ($("step-run")) $("step-run").onclick = () => { $("term-in").value = s.cmd; submit(s.cmd); };
  if ($("step-open")) $("step-open").onclick = () => { openFile = s.open; showTab("files"); };
  if ($("step-edit")) $("step-edit").onclick = () => applyEdit(s.edit);
  if ($("step-next")) $("step-next").onclick = () => {
    if (s.done?.read && !a.read.includes(a.step)) a.read.push(a.step);
    a.step += 1; lastNarration = [];
    const st = activity.steps[a.step];
    if (st?.open) openFile = st.open;
    showTab(st && st.open && !st.cmd ? "files" : "picture");
    persist(); renderLesson();
    $("guide").querySelector(".step.current .step-head, #finished")?.scrollIntoView({ block: "nearest", behavior: calm.matches ? "auto" : "smooth" });
  };
  if ($("to-home")) $("to-home").onclick = showHome;
  if ($("open-work")) $("open-work").onclick = openWork;
  if (s && s.open && !s.cmd && a.step === 0 && !a.read.includes(0)) showTab("files");
}

// "Show me" and "Make the change for me": edit a file the way the step describes.
function applyEdit(e) {
  let text = world.host.files[e.path] || "";
  if (e.append) text += e.append;
  if (e.find && text.includes(e.find)) text = text.replace(e.find, e.replace);
  if (e.also && text.includes(e.also.find)) text = text.replace(e.also.find, e.also.replace);
  const a = store.activityState(state, activity.id);
  if (/show me/i.test(e.label)) a.hintsUsed = Math.min(activity.hints.length, a.hintsUsed + 1);
  saveEdit(e.path, text);
  openFile = e.path;
  showTab("files");
  renderLesson();
}

function saveEdit(path, text) {
  if (text === world.host.files[path]) return;
  world = setFile(world, path, text);
  store.activityState(state, activity.id).log.push({ kind: "edit", path, text, at: new Date().toISOString() });
  persist();
}

// ---------- predictions, asked inside the current step ----------

function ask(p) {
  return new Promise((resolve) => {
    let slot = $("ask-slot");
    if (!slot) { // the step isn't showing (a typed command): ask above the terminal instead
      slot = document.createElement("div"); slot.id = "ask-slot"; $("console").prepend(slot);
    }
    slot.innerHTML = `<div class="ask" role="group" aria-labelledby="ask-q"><p class="ask-label">Predict first</p>
      <p id="ask-q">${esc(p.question)}</p>
      <ul>${p.choices.map((c, i) => `<li><button type="button" class="choice" data-i="${i}">${esc(c)}</button></li>`).join("")}</ul>
      <p class="q">Your answer is recorded, right or wrong. Then the command runs.</p></div>`;
    slot.querySelector(".choice").focus();
    pendingAsk = slot;
    slot.onclick = (ev) => {
      const b = ev.target.closest(".choice");
      if (!b) return;
      const i = Number(b.dataset.i);
      slot.innerHTML = `<p class="asked">You predicted: <strong>${esc(p.choices[i])}</strong>. ${i === p.answer ? "Let's see." : "Let's see if you're right."}</p>`;
      pendingAsk = null;
      resolve(i);
    };
  });
}

// ---------- the terminal ----------

function print(text, cls = "") {
  const out = $("term-out");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text.endsWith("\n") ? text : text + "\n";
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, skip || calm.matches ? 0 : ms));

function thinkTime(line) {
  if (/compose up/.test(line)) return 900;
  if (/docker build|compose build/.test(line)) return 700;
  if (/docker run/.test(line)) return 550;
  if (/npm run seed|psql/.test(line)) return 450;
  if (/curl/.test(line)) return 300;
  return 220;
}

function lineDelay(l, prev) {
  if (/DONE 0\.5s/.test(l) && /npm ci/.test(prev)) return 900;
  if (/Pulling from|Downloaded newer image| Pulled$/.test(l)) return 650;
  if (/Healthy$/.test(l)) return 1000;
  if (/ Started$| Created$| Removed$| Running$/.test(l)) return 220;
  if (/^#\d+ \[\d+\/\d+\]/.test(l)) return 90;
  if (/^#\d+ (DONE|CACHED)/.test(l)) return 70;
  if (/exporting to image|naming to/.test(l)) return 160;
  if (/^places table now has/.test(l)) return 600;
  return 18;
}

async function spinner(ms) {
  if (skip || calm.matches || ms <= 0) return;
  const el = document.createElement("span");
  el.className = "spin";
  $("term-out").appendChild(el);
  const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const start = performance.now();
  let i = 0;
  while (!skip && performance.now() - start < ms) {
    el.textContent = `${frames[i++ % frames.length]} running\n`;
    $("term-out").scrollTop = $("term-out").scrollHeight;
    await new Promise((r) => setTimeout(r, 80));
  }
  el.remove();
}

async function play(text, cls, line) {
  await spinner(thinkTime(line));
  let prev = "", failed = false;
  for (const l of text.replace(/\n$/, "").split("\n")) {
    await sleep(lineDelay(l, prev));
    // In a failed command, only the error and what follows it are red.
    if (cls === "err" && /error|ERROR|Error|failed|denied|not found|refused|Couldn't|does not exist|not running|missing/.test(l)) failed = true;
    print(l, cls === "err" ? (failed ? "err" : "") : cls);
    prev = l;
  }
}

function setRunning(on) {
  running = on; skip = false;
  $("term-in").disabled = on;
  $("term-run").hidden = on;
  $("term-skip").hidden = !on;
  if ($("step-run")) $("step-run").disabled = on;
  if (!on) $("term-in").focus({ preventScroll: true });
}

async function submit(line) {
  line = line.trim();
  if (!line || running || pendingAsk) return;
  $("term-in").value = "";
  history.push(line); hpos = history.length;
  const a = store.activityState(state, activity.id);
  for (const p of activity.predictions) {
    if (new RegExp(p.when).test(line) && !a.predictions.some((x) => x.id === p.id)) {
      const choice = await ask(p);
      a.predictions.push({ id: p.id, choice, answer: p.choices[choice], correct: choice === p.answer, at: new Date().toISOString() });
    }
  }
  print(`$ ${line}`, "cmd");
  if (line === "clear") { $("term-out").textContent = ""; return; }
  if (!/docker (compose )?exec|curl/.test(line) || /compose up/.test(line)) showTab("picture");
  const r = run(world, line);
  a.log.push({ kind: "cmd", text: line, ok: r.ok, at: new Date().toISOString() });
  a.attempts += 1;
  persist();
  setRunning(true);
  if (r.out) await play(r.out, r.ok ? "" : "err", line);
  else await spinner(thinkTime(line) / 2);
  prevWorld = world;
  world = r.world; lastEvents = r.events; lastNarration = narrate(world, r.events);
  setRunning(false);
  renderLesson();
  persist();
}

// ---------- the stage: picture or files ----------

function showTab(which) {
  const pic = which === "picture";
  $("tab-picture").setAttribute("aria-selected", pic);
  $("tab-files").setAttribute("aria-selected", !pic);
  $("panel-picture").hidden = !pic;
  $("panel-files").hidden = pic;
  $("files-note").hidden = pic || true;
  if (!pic) renderFiles();
}

function renderFiles() {
  if (!world) return;
  const paths = Object.keys(world.host.files).filter((p) => !p.includes("node_modules")).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  if (!paths.includes(openFile)) openFile = paths[0];
  $("file-tabs").innerHTML = paths.map((p) => `<option value="${esc(p)}"${p === openFile ? " selected" : ""}>${esc(p)}</option>`).join("");
  if (document.activeElement !== $("file-text")) $("file-text").value = world.host.files[openFile] ?? "";
  const issues = lint(openFile, world.host.files[openFile] ?? "", world.host.files);
  $("file-lint").innerHTML = issues.map((m) => `<li>${esc(m)}</li>`).join("");
}
const rank = (p) => (p.endsWith("Dockerfile") ? 0 : p === "docker-compose.yml" ? 1 : p === ".dockerignore" ? 2 : p === ".env" ? 3 : p.startsWith("db/") ? 4 : 5);

// Plain-words checks, before anything runs.
export function lint(path, text, files) {
  const out = [];
  if (path.endsWith("Dockerfile")) {
    for (const line of text.split("\n")) {
      const m = line.trim().match(/^COPY\s+(.+)\s+\S+$/i);
      if (m) for (const src of m[1].split(/\s+/)) {
        const s = src.replace(/\/$/, "");
        if (!Object.keys(files).some((p) => p === s || p.startsWith(s + "/"))) out.push(`COPY ${src}: there is no ${s} in the repo, so the build will fail.`);
      }
      if (/^ENV\s+.*(PASSWORD|SECRET|TOKEN)/i.test(line.trim())) out.push("A password in an ENV line is baked into the image: anyone with the image can read it. Pass it with -e when the container starts.");
    }
    const lines = text.split("\n").map((l) => l.trim());
    const ci = lines.findIndex((l) => /^RUN npm ci/.test(l)), all = lines.findIndex((l) => /^COPY places-api\/ /.test(l));
    if (ci > -1 && all > -1 && all < ci) out.push("All of places-api/ is copied before npm ci, so any change to the code reinstalls every package.");
  }
  if (path === "docker-compose.yml") {
    let doc;
    try { doc = parseYaml(text); } catch (e) { return [`This isn't valid YAML yet: ${e.message}`]; }
    const s = (doc && doc.services) || {};
    for (const [name, svc] of Object.entries(s)) {
      const url = svc.environment && svc.environment.DATABASE_URL;
      if (url && /@localhost[:/]/.test(url)) out.push(`${name}: DATABASE_URL points at localhost, which inside a container means the container itself. Use the service name, db.`);
      if (svc.image && svc.image.includes("postgis") && svc.ports) out.push(`${name}: publishing the database's port lets anything on your network reach it. Only places-api needs it, on the Compose network.`);
      const deps = svc.depends_on && !Array.isArray(svc.depends_on) ? svc.depends_on : {};
      for (const [d, c] of Object.entries(deps)) if (c && c.condition === "service_healthy" && s[d] && !s[d].healthcheck) out.push(`${name} waits for ${d} to be healthy, but ${d} has no healthcheck, so it never will be.`);
      if (Array.isArray(svc.depends_on) && svc.depends_on.includes("db") && s.db && s.db.image && s.db.image.includes("postgis")) out.push(`${name}: plain depends_on waits for db's container to start, not for the database to be ready.`);
    }
  }
  if (path === ".dockerignore" && !/^\.env$/m.test(text)) out.push(".env isn't listed, so docker build may copy your passwords into the image.");
  return out;
}

// ---------- my work: name, export, import ----------

function workPanel() {
  const exported = state.lastExport ? `Last exported ${new Date(state.lastExport).toLocaleString()}.` : "Not exported yet.";
  return `<p class="q">Your work is saved in this browser on this computer as you go. ${exported} Clearing the browser, a private window or another computer starts empty, so export to keep a copy. The exported file is what you submit in Canvas.</p>
    <div class="work-form">
      <label>Name <input data-w="name" autocomplete="name" value="${esc(state.student.name)}"></label>
      <label>UMass email <input data-w="email" type="email" autocomplete="email" value="${esc(state.student.email)}"></label>
      <button type="button" data-w="export">Export my work</button>
      <label class="file-btn">Import a file <input data-w="import" type="file" accept="application/json,.json"></label>
    </div>
    ${activity ? `<p><button type="button" class="quiet" data-w="reset">Start this activity over</button></p>` : ""}`;
}

function wireWork(root) {
  root.querySelectorAll("input[data-w=name], input[data-w=email]").forEach((i) => i.onchange = () => { state.student[i.dataset.w] = i.value.trim(); persist(); });
  root.querySelector("[data-w=export]").onclick = exportWork;
  root.querySelector("input[data-w=import]").onchange = importWork;
  const reset = root.querySelector("[data-w=reset]");
  if (reset) reset.onclick = () => {
    if (!confirm(`Start "${activity.title}" over? Its commands and edits are cleared; predictions and hints stay recorded.`)) return;
    const a = store.activityState(state, activity.id);
    a.log.push({ kind: "reset", at: new Date().toISOString() });
    a.step = 0; a.read = [];
    $("mywork").close();
    openActivity(activity.id);
  };
}

function openWork() {
  $("work-dialog").innerHTML = workPanel();
  wireWork($("work-dialog"));
  $("mywork").showModal();
}

async function exportWork() {
  if (!state.student.name || !state.student.email) { alert("Type your name and UMass email first: they go in the file you submit."); return; }
  const now = new Date().toISOString();
  const file = await store.makeExport(state, ACTIVITIES, ENGINE_VERSION, now);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `426-sim-${state.student.email.split("@")[0] || "work"}-${now.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  state.lastExport = now;
  persist();
  if ($("mywork").open) { $("work-dialog").innerHTML = workPanel(); wireWork($("work-dialog")); }
  if (!activity) showHome();
}

async function importWork(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const { state: loaded, edited } = await store.readExport(await f.text());
    if (edited && !confirm("This file has been changed by hand since it was exported. Load it anyway?")) return;
    Object.assign(state, loaded);
    persist();
    if ($("mywork").open) $("mywork").close();
    showHome();
  } catch (err) {
    alert(`Couldn't load that file: ${err.message}`);
  }
}

function persist() {
  if (!store.save(state)) console.warn("This browser isn't keeping work: export before leaving.");
}

// ---------- wiring ----------

$("cards").addEventListener("click", (e) => { const b = e.target.closest("[data-open]"); if (b) openActivity(b.dataset.open); });
$("back").onclick = showHome;
$("tour").onclick = startTour;
$("mywork-btn").onclick = openWork;
$("mywork-close").onclick = () => $("mywork").close();
$("tab-picture").onclick = () => showTab("picture");
$("tab-files").onclick = () => showTab("files");
$("hint-btn").onclick = () => { const a = store.activityState(state, activity.id); a.hintsUsed = Math.min(activity.hints.length, a.hintsUsed + 1); persist(); renderLesson(); };
$("term-skip").onclick = () => { skip = true; };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && running) skip = true; });
$("term-form").addEventListener("submit", (e) => { e.preventDefault(); submit($("term-in").value); });
$("term-in").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && hpos > 0) { hpos--; $("term-in").value = history[hpos]; e.preventDefault(); }
  if (e.key === "ArrowDown") { hpos = Math.min(history.length, hpos + 1); $("term-in").value = history[hpos] ?? ""; e.preventDefault(); }
});
$("file-tabs").onchange = (e) => { openFile = e.target.value; renderFiles(); };
let editTimer;
$("file-text").addEventListener("input", () => {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    saveEdit(openFile, $("file-text").value);
    $("file-lint").innerHTML = lint(openFile, world.host.files[openFile], world.host.files).map((m) => `<li>${esc(m)}</li>`).join("");
    renderLesson();
  }, 400);
});

if (state.current && activityById(state.current)) openActivity(state.current);
else showHome();
