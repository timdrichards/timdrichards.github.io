// app.js: the container simulator's screen. Terminal on the left, the world in the
// middle, the repo's files on the right, and the current activity across the top.

import { newWorld, run, setFile, check, replay, ENGINE_VERSION } from "./engine.js";
import { parseYaml } from "./yaml.js";
import { ACTIVITIES, activityById } from "./activities.js";
import { draw, narrate } from "./view.js";
import * as store from "./store.js";
import { startTour, maybeTour } from "./tour.js";

const $ = (id) => document.getElementById(id);
const state = store.load();
let activity = activityById(state.current) || ACTIVITIES[0];
let world, lastEvents = [], history = [], hpos = 0, openFile = null;
let running = false, skip = false;
const calm = window.matchMedia("(prefers-reduced-motion: reduce)");

// ---------- making a command look like it runs ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, skip || calm.matches ? 0 : ms));

// How long a command "thinks" before its first line: longer for the ones that do more.
function thinkTime(line) {
  if (/compose up/.test(line)) return 900;
  if (/docker build|compose build/.test(line)) return 700;
  if (/docker run/.test(line)) return 550;
  if (/npm run seed|psql/.test(line)) return 450;
  if (/curl/.test(line)) return 300;
  return 220;
}

// How long to wait before each line, so slow steps look slow and quick ones quick.
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

// Print a command's output a line at a time, scrolling as it goes.
async function play(text, cls, line) {
  await spinner(thinkTime(line));
  const lines = text.replace(/\n$/, "").split("\n");
  let prev = "";
  for (const l of lines) {
    await sleep(lineDelay(l, prev));
    print(l, cls);
    prev = l;
  }
}

function setRunning(on) {
  running = on;
  skip = false;
  $("term-in").disabled = on;
  $("term-run").hidden = on;
  $("term-skip").hidden = !on;
  if (!on) $("term-in").focus({ preventScroll: true });
}


// ---------- activities ----------

function startWorld(a) {
  return newWorld(a.files());
}

function selectActivity(id) {
  activity = activityById(id);
  state.current = id;
  const a = store.activityState(state, id);
  world = replay(startWorld(activity), a.log);
  lastEvents = [];
  $("term-out").textContent = "";
  print(`# ${activity.title}\n# ${activity.intro}\n# Type "help" for the commands this simulator runs.\n`, "note");
  openFile = Object.keys(world.host.files).find((p) => p.endsWith("Dockerfile") || p === "docker-compose.yml") || ".env";
  renderAll();
  persist();
}

function renderGoals() {
  const a = store.activityState(state, activity.id);
  let all = true;
  $("goals").innerHTML = activity.goals.map((g) => {
    const ok = check(world, g.check) || a.goals[g.id];
    if (ok) a.goals[g.id] = true;
    all = all && ok;
    return `<li class="${ok ? "done" : ""}"><span aria-hidden="true">${ok ? "✓" : "○"}</span> ${g.text}${ok ? '<span class="sr"> (done)</span>' : ""}</li>`;
  }).join("");
  if (all && !a.reached) { a.reached = true; persist(); }
  $("forreal").hidden = !a.reached;
  $("forreal-cmds").textContent = activity.forReal.join("\n");
  $("hint-count").textContent = `${a.hintsUsed} of ${activity.hints.length} used`;
  $("hints").innerHTML = activity.hints.slice(0, a.hintsUsed).map((h) => `<li>${escapeHtml(h)}</li>`).join("");
  $("hint-btn").disabled = a.hintsUsed >= activity.hints.length;
  $("suggested").innerHTML = activity.suggested.map((s) => s.startsWith("(") ? `<li class="q">${escapeHtml(s)}</li>` : `<li><button type="button" class="chip" data-cmd="${escapeAttr(s)}">${escapeHtml(s)}</button></li>`).join("");
}

// ---------- terminal ----------

function print(text, cls = "") {
  const out = $("term-out");
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text.endsWith("\n") ? text : text + "\n";
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

async function submit(line) {
  line = line.trim();
  if (!line) return;
  history.push(line); hpos = history.length;
  const a = store.activityState(state, activity.id);
  // Predict first: a prediction asked before its command runs.
  for (const p of activity.predictions) {
    if (new RegExp(p.when).test(line) && !a.predictions.some((x) => x.id === p.id)) {
      const choice = await ask(p);
      a.predictions.push({ id: p.id, choice, answer: p.choices[choice], correct: choice === p.answer, at: new Date().toISOString() });
    }
  }
  print(`$ ${line}`, "cmd");
  if (line === "clear") { $("term-out").textContent = ""; return; }
  // The engine answers at once; the screen plays it back as a real terminal would.
  const r = run(world, line);
  a.log.push({ kind: "cmd", text: line, ok: r.ok, at: new Date().toISOString() });
  a.attempts += 1;
  persist();
  setRunning(true);
  if (r.out) await play(r.out, r.ok ? "" : "err", line);
  else await spinner(thinkTime(line) / 2);
  world = r.world; lastEvents = r.events;
  setRunning(false);
  renderAll();
  persist();
}

function ask(p) {
  return new Promise((resolve) => {
    const dlg = $("predict");
    $("predict-q").textContent = p.question;
    $("predict-choices").innerHTML = p.choices.map((c, i) => `<li><button type="button" data-i="${i}">${escapeHtml(c)}</button></li>`).join("");
    dlg.showModal();
    $("predict-choices").onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      dlg.close();
      resolve(Number(b.dataset.i));
    };
  });
}

// ---------- files ----------

function renderFiles() {
  const paths = Object.keys(world.host.files).filter((p) => !p.includes("node_modules")).sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  $("file-tabs").innerHTML = paths.map((p) => `<option value="${escapeAttr(p)}"${p === openFile ? " selected" : ""}>${escapeHtml(p)}</option>`).join("");
  $("file-text").value = world.host.files[openFile] ?? "";
  $("file-lint").innerHTML = lint(openFile, world.host.files[openFile] ?? "", world.host.files).map((m) => `<li>${escapeHtml(m)}</li>`).join("");
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
    }
  }
  if (path === ".dockerignore" && !/^\.env$/m.test(text)) out.push(".env isn't listed, so docker build may copy your passwords into the image.");
  return out;
}

// ---------- the whole screen ----------

function renderAll() {
  draw($("world"), world, lastEvents);
  const said = narrate(world, lastEvents);
  $("events").innerHTML = said.map((s) => `<li>${escapeHtml(s)}</li>`).join("") || "<li class=q>Run a command to see what it does.</li>";
  renderGoals();
  renderFiles();
  $("activity").innerHTML = ACTIVITIES.map((a) => {
    const st = state.activities[a.id];
    return `<option value="${a.id}"${a.id === activity.id ? " selected" : ""}>Unit ${a.unit}: ${escapeHtml(a.title)}${st && st.reached ? " ✓" : ""}</option>`;
  }).join("");
  $("student-name").value = state.student.name;
  $("student-email").value = state.student.email;
  $("saved").textContent = `Saved in this browser on this computer${state.lastExport ? " · last export " + new Date(state.lastExport).toLocaleString() : " · not exported yet"}`;
}

function persist() {
  if (!store.save(state)) $("saved").textContent = "This browser isn't keeping your work (private window or storage blocked). Export before you leave.";
}

const escapeHtml = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const escapeAttr = (s) => escapeHtml(s).replace(/"/g, "&quot;");

// ---------- wiring ----------

$("term-skip").addEventListener("click", () => { skip = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && running) skip = true; });
$("term-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (running) return;
  const v = $("term-in").value;
  $("term-in").value = "";
  submit(v);
});
$("term-in").addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" && hpos > 0) { hpos--; $("term-in").value = history[hpos]; e.preventDefault(); }
  if (e.key === "ArrowDown") { hpos = Math.min(history.length, hpos + 1); $("term-in").value = history[hpos] ?? ""; e.preventDefault(); }
});
$("suggested").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmd]");
  if (b) { $("term-in").value = b.dataset.cmd; $("term-in").focus({ preventScroll: true }); }
});
$("activity").addEventListener("change", (e) => selectActivity(e.target.value));
$("file-tabs").addEventListener("change", (e) => { openFile = e.target.value; renderFiles(); });
let editTimer;
$("file-text").addEventListener("input", () => {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => {
    const text = $("file-text").value;
    if (text === world.host.files[openFile]) return;
    world = setFile(world, openFile, text);
    store.activityState(state, activity.id).log.push({ kind: "edit", path: openFile, text, at: new Date().toISOString() });
    $("file-lint").innerHTML = lint(openFile, text, world.host.files).map((m) => `<li>${escapeHtml(m)}</li>`).join("");
    renderGoals();
    persist();
  }, 400);
});
$("hint-btn").addEventListener("click", () => {
  const a = store.activityState(state, activity.id);
  a.hintsUsed = Math.min(activity.hints.length, a.hintsUsed + 1);
  renderGoals(); persist();
});
$("reset").addEventListener("click", () => {
  if (!confirm(`Start "${activity.title}" over? Your commands and edits for it are cleared (predictions and hints stay recorded).`)) return;
  const a = store.activityState(state, activity.id);
  a.log.push({ kind: "reset", at: new Date().toISOString() });
  world = startWorld(activity); lastEvents = [];
  $("term-out").textContent = "";
  renderAll(); persist();
});
for (const f of ["name", "email"]) {
  $(`student-${f}`).addEventListener("change", (e) => { state.student[f] = e.target.value.trim(); persist(); });
}
$("export").addEventListener("click", async () => {
  if (!state.student.name || !state.student.email) { alert("Type your name and UMass email first: they go in the file you submit."); return; }
  const now = new Date().toISOString();
  const file = await store.makeExport(state, ACTIVITIES, ENGINE_VERSION, now);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `426-sim-${state.student.email.split("@")[0] || "work"}-${now.slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  state.lastExport = now; persist(); renderAll();
});
$("import").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const { state: loaded, edited } = await store.readExport(await f.text());
    if (edited && !confirm("This file has been changed by hand since it was exported. Load it anyway?")) return;
    Object.assign(state, loaded);
    persist();
    selectActivity(state.current || ACTIVITIES[0].id);
    print(`# Loaded ${f.name}.`, "note");
  } catch (err) {
    alert(`Couldn't load that file: ${err.message}`);
  }
  e.target.value = "";
});

$("tour").addEventListener("click", startTour);
selectActivity(activity.id);
$("term-in").focus({ preventScroll: true });
maybeTour();
