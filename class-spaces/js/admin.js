// Admin app: login, spaces, activities, results, projector, export.
// Routes (hash): #/  #/s/<space>  #/s/<space>/new  #/e/<activity>  #/a/<activity>  #/p/<activity>
//                 #/c/<space>[/<activity>]  class view: one tab per activity, live

import { sb, configured, esc, store, studentUrl, shortLabel, qrSvg, notConfiguredHtml, fetchAll, errorText } from "./common.js";
import { KINDS, PICKABLE, forScreen, renderResults, activityCsvRows, toCsv } from "./kinds.js";

const app = document.getElementById("app");
const dlg = document.getElementById("dlg");
const LIVE_MS = 3000;
let liveTimer = null;
let session = null;
let isAdmin = false;
let firstAuth = true;

if (!configured) {
  app.innerHTML = notConfiguredHtml();
} else {
  // Don't await Supabase calls inside this callback (supabase-js can deadlock); defer them.
  sb.auth.onAuthStateChange((_event, s) => {
    const changed = firstAuth || (s?.user?.id || null) !== (session?.user?.id || null);
    firstAuth = false;
    session = s;
    if (changed) setTimeout(async () => { isAdmin = await checkAdmin(); route(); }, 0);
  });
  window.addEventListener("hashchange", route);
}

async function checkAdmin() {
  if (!session) return false;
  const { data } = await sb.from("admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
  return Boolean(data);
}

function route() {
  clearInterval(liveTimer);
  liveTimer = null;
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [view, id, sub] = parts;
  // Keep the full-width projector layout while moving between class-view tabs or into the
  // projector, so the page doesn't shrink and stretch while the next view loads.
  if (!session || !isAdmin || !["c", "p"].includes(view)) document.body.classList.remove("projecting");
  if (!session) return showLogin();
  if (!isAdmin) return showNotAdmin();
  const go = {
    s: () => (sub === "new" ? showActivityForm({ spaceId: id }) : showSpace(id)),
    e: () => showActivityForm({ activityId: id }),
    a: () => showResults(id),
    p: () => showProjector(id),
    c: () => showClass(id, sub),
  }[view];
  (go || showSpaces)().catch(fail);
}

function fail(e) {
  console.error(e);
  app.innerHTML = `${nav()}<div class="panel"><p class="error">${esc(errorText(e))}</p>
    <p><a href="#/">Back to spaces</a></p></div>`;
}

function nav(crumbs = "") {
  return `<nav class="top"><a href="#/" class="brand">Class Spaces</a>${crumbs}
    <span class="spacer"></span><span class="muted small">${esc(session?.user?.email || "")}</span>
    <button class="link" id="signout">Sign out</button></nav>`;
}

function wireNav() {
  app.querySelector("#signout")?.addEventListener("click", () => sb.auth.signOut());
}

function must({ data, error }) {
  if (error) throw error;
  return data;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";
const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDate = (d) => (d ? new Date(d + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "");

// ---------------------------------------------------------------- login

function showLogin(msg = "", email = "") {
  app.innerHTML = `<div class="panel narrow">
    <h1>Class Spaces</h1>
    <form id="login" class="stack-form">
      <label>Email<input type="email" name="email" autocomplete="username" required value="${esc(email)}"></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
      ${msg ? `<p class="error">${esc(msg)}</p>` : ""}
      <button class="primary">Sign in</button>
    </form></div>`;
  app.querySelector("#login").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
    if (error) showLogin(error.message, f.email.value.trim());
  };
}

function showNotAdmin() {
  app.innerHTML = `${nav()}<div class="panel narrow"><p>This account is not an admin.</p></div>`;
  wireNav();
}

// ---------------------------------------------------------------- spaces

async function showSpaces() {
  const spaces = must(await sb.from("spaces").select("*, activities(count)")
    .order("meets_on", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }));
  const showArchived = store.get("cs.showArchived", false);
  const list = spaces.filter((s) => showArchived || !s.archived);
  app.innerHTML = `${nav()}
    <div class="page">
      <div class="head-row"><h1>Spaces</h1>
        <label class="check small"><input type="checkbox" id="arch" ${showArchived ? "checked" : ""}> Show archived</label></div>
      <ul class="list">${list.map((s) => `
        <li><a href="#/c/${s.id}"><strong>${esc(s.title)}</strong></a> <a class="small" href="#/s/${s.id}">Manage</a>
          <span class="muted">${esc([s.course, fmtDate(s.meets_on)].filter(Boolean).join(" · "))}
          · ${s.activities[0]?.count ?? 0} activities${s.archived ? " · archived" : ""}</span></li>`).join("")
        || `<li class="muted">No spaces yet.</li>`}</ul>
      <form id="new-space" class="panel stack-form">
        <h2>New space</h2>
        <label>Title<input name="title" maxlength="200" required placeholder="879 Wed Oct 28"></label>
        <div class="row">
          <label>Course<input name="course" maxlength="50" placeholder="879"></label>
          <label>Meets on<input type="date" name="meets_on"></label>
        </div>
        <button class="primary">Create space</button>
      </form>
    </div>`;
  wireNav();
  app.querySelector("#arch").onchange = (e) => { store.set("cs.showArchived", e.target.checked); route(); };
  app.querySelector("#new-space").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = must(await sb.from("spaces").insert({
      title: f.title.value.trim(), course: f.course.value.trim() || null, meets_on: f.meets_on.value || null,
    }).select().single());
    location.hash = `#/s/${row.id}`;
  };
}

async function loadSpace(id) {
  const space = must(await sb.from("spaces").select("*").eq("id", id).single());
  const acts = must(await sb.from("activities").select("*, responses(count)").eq("space_id", id)
    .order("position").order("created_at"));
  return { space, acts };
}

async function showSpace(id) {
  const { space, acts } = await loadSpace(id);
  app.innerHTML = `${nav(` / ${esc(space.title)}`)}
    <div class="page">
      <div class="head-row"><div><h1>${esc(space.title)}</h1>
        <p class="muted">${esc([space.course, fmtDate(space.meets_on)].filter(Boolean).join(" · "))}${space.archived ? " · archived" : ""}</p>
        ${space.code ? `<p>Join code <strong class="space-code">${esc(space.code)}</strong>: students see every activity, open ones on top. <button id="space-qr">QR</button></p>` : ""}</div>
        <div class="btns">
          <a class="button primary" href="#/c/${id}">Class view</a>
          <a class="button" href="#/s/${id}/new">New activity</a>
          <button id="export-json">Export JSON</button>
          <button id="close-all">Close all</button>
          <button id="copy-space">Copy space</button>
          <button id="edit-space">Edit</button>
        </div></div>
      <ul class="acts">${acts.map((a, i) => `
        <li class="act ${a.is_open ? "open" : ""}">
          <div class="act-main">
            <span class="badge">${esc(KINDS[a.kind].label)}</span>
            <a href="#/a/${a.id}" class="act-title">${esc(a.title)}</a>
            <span class="muted small">code <strong>${esc(a.code)}</strong> · ${a.responses[0]?.count ?? 0} responses</span>
          </div>
          <div class="btns">
            <button data-toggle="${a.id}" class="${a.is_open ? "danger" : "primary"}">${a.is_open ? "Close" : "Open"}</button>
            <a class="button" href="#/p/${a.id}">Projector</a>
            <a class="button" href="#/a/${a.id}">Results</a>
            <button data-qr="${a.code}" data-title="${esc(a.title)}">QR</button>
            <a class="button" href="#/e/${a.id}">Edit</a>
            <button data-move="${i}:-1" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
            <button data-move="${i}:1" ${i === acts.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
          </div>
        </li>`).join("") || `<li class="muted">No activities yet.</li>`}</ul>
    </div>`;
  wireNav();
  app.querySelectorAll("[data-toggle]").forEach((b) => b.onclick = async () => {
    const a = acts.find((x) => x.id === b.dataset.toggle);
    must(await sb.from("activities").update({ is_open: !a.is_open }).eq("id", a.id));
    route();
  });
  app.querySelectorAll("[data-qr]").forEach((b) => b.onclick = () => showQr(b.dataset.qr, b.dataset.title));
  app.querySelectorAll("[data-move]").forEach((b) => b.onclick = async () => {
    const [i, d] = b.dataset.move.split(":").map(Number);
    const order = acts.map((a) => a.id);
    [order[i], order[i + d]] = [order[i + d], order[i]];
    await Promise.all(order.map((aid, pos) => sb.from("activities").update({ position: pos }).eq("id", aid)));
    route();
  });
  app.querySelector("#close-all").onclick = async () => {
    must(await sb.from("activities").update({ is_open: false }).eq("space_id", id).eq("is_open", true));
    route();
  };
  app.querySelector("#export-json").onclick = () => exportSpaceJson(space, acts);
  app.querySelector("#edit-space").onclick = () => editSpace(space);
  app.querySelector("#copy-space").onclick = () => copySpace(space, acts);
  const sq = app.querySelector("#space-qr");
  if (sq) sq.onclick = () => showQr(space.code, `${space.title}: all activities`);
}

// A new space with the same activities (new codes, all closed, no responses), then edit its title and date.
async function copySpace(space, acts) {
  const copy = must(await sb.from("spaces").insert({
    title: `${space.title} (copy)`.slice(0, 200), course: space.course, meets_on: null,
  }).select().single());
  if (acts.length) {
    must(await sb.from("activities").insert(acts.map((a, i) => ({
      space_id: copy.id, kind: a.kind, title: a.title, prompt: a.prompt, config: a.config, guide: a.guide || {},
      position: i, is_open: false,
    }))));
  }
  location.hash = `#/s/${copy.id}`;
  editSpace(copy);
}

function editSpace(space) {
  dlg.innerHTML = `<form method="dialog" class="stack-form" id="es">
    <h2>Edit space</h2>
    <label>Title<input name="title" maxlength="200" required value="${esc(space.title)}"></label>
    <div class="row">
      <label>Course<input name="course" maxlength="50" value="${esc(space.course)}"></label>
      <label>Meets on<input type="date" name="meets_on" value="${esc(space.meets_on)}"></label>
    </div>
    <label class="check"><input type="checkbox" name="archived" ${space.archived ? "checked" : ""}> Archived</label>
    <div class="btns"><button value="cancel" formnovalidate>Cancel</button><button value="save" class="primary">Save</button></div>
  </form>`;
  const f = dlg.querySelector("#es");
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    must(await sb.from("spaces").update({
      title: f.title.value.trim(), course: f.course.value.trim() || null,
      meets_on: f.meets_on.value || null, archived: f.archived.checked,
    }).eq("id", space.id));
    dlg.close();
    route();
  };
  dlg.showModal();
}

function showQr(code, title) {
  const url = studentUrl(code);
  dlg.innerHTML = `<div class="qr-dlg">
    <h2>${esc(title)}</h2>
    <div class="qr">${qrSvg(url)}</div>
    <p class="qr-url">${esc(shortLabel(url))}</p>
    <div class="btns"><button id="copy">Copy link</button><button id="x" class="primary">Done</button></div>
  </div>`;
  dlg.querySelector("#copy").onclick = async (e) => {
    try { await navigator.clipboard.writeText(url); e.target.textContent = "Copied"; } catch { e.target.textContent = url; }
  };
  dlg.querySelector("#x").onclick = () => dlg.close();
  dlg.showModal();
}

// ---------------------------------------------------------------- activity form

async function showActivityForm({ spaceId, activityId }) {
  let act = null;
  let count = 0;
  if (activityId) {
    act = must(await sb.from("activities").select("*, responses(count)").eq("id", activityId).single());
    spaceId = act.space_id;
    count = act.responses[0]?.count ?? 0;
  }
  const space = must(await sb.from("spaces").select("id,title").eq("id", spaceId).single());
  let kind = act?.kind || store.get("cs.lastKind", "card");
  const locked = count > 0;

  app.innerHTML = `${nav(` / <a href="#/s/${space.id}">${esc(space.title)}</a> / ${act ? "Edit" : "New activity"}`)}
    <div class="page narrow">
      <form id="af" class="panel stack-form">
        <h1>${act ? "Edit activity" : "New activity"}</h1>
        <label>Type<select name="kind" ${act ? "disabled" : ""}>
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${k === kind ? "selected" : ""}>${esc(v.label)}</option>`).join("")}
        </select></label>
        <label>Title<input name="title" maxlength="200" required value="${esc(act?.title)}"></label>
        <label>Prompt shown to students<textarea name="prompt" rows="3" maxlength="2000">${esc(act?.prompt)}</textarea></label>
        <fieldset id="kind-fields" ${locked ? "disabled" : ""}></fieldset>
        ${locked ? `<p class="muted small">Options are locked because this activity has ${count} responses. Title and prompt can still change.</p>` : ""}
        <label>Group label<select name="group">
          ${[["optional", "Ask for an optional group name"], ["required", "Require a group name"],
             ["random", "Give each group a random name (e.g. Teal Otter)"], ["off", "Don't ask"]]
            .map(([v, t]) => `<option value="${v}" ${(act?.config?.group || "optional") === v ? "selected" : ""}>${t}</option>`).join("")}
        </select></label>
        <fieldset class="guide-edit">
          <legend>Answer guide <span class="muted small">(only you see this, on the activity's admin page; never students or the projector)</span></legend>
          <label>Notes for you<textarea name="guide_notes" rows="3" maxlength="4000"
            placeholder="What this activity is for, what a good answer looks like, where to take the discussion">${esc(act?.guide?.notes)}</textarea></label>
          <div id="pairs"></div>
          <button type="button" id="add-pair">Add a likely answer</button>
        </fieldset>
        <p id="err" class="error"></p>
        <div class="btns">
          <a class="button" href="${act ? `#/a/${act.id}` : `#/s/${space.id}`}">Cancel</a>
          ${act && !count ? `<button type="button" id="del" class="danger">Delete</button>` : ""}
          <button class="primary">${act ? "Save" : "Create"}</button>
        </div>
      </form>
    </div>`;
  wireNav();
  const f = app.querySelector("#af");
  const fields = f.querySelector("#kind-fields");
  const draw = () => { fields.innerHTML = KINDS[kind].editor(act && act.kind === kind ? act.config : KINDS[kind].defaults); };
  draw();
  f.kind.onchange = () => { kind = f.kind.value; draw(); };

  // Answer guide rows: "if they say" / "you might say". Editable even when options are locked.
  const pairsBox = f.querySelector("#pairs");
  const pairRow = (p = {}) => `<div class="pair-row">
      <label>If they say<textarea data-if rows="2" maxlength="1000">${esc(p.if)}</textarea></label>
      <label>You might say<textarea data-say rows="2" maxlength="1000">${esc(p.say)}</textarea></label>
      <button type="button" class="small" data-drop aria-label="Remove this answer">Remove</button>
    </div>`;
  const wirePairs = () => pairsBox.querySelectorAll("[data-drop]").forEach((b) => b.onclick = () => b.closest(".pair-row").remove());
  pairsBox.innerHTML = (act?.guide?.pairs || []).map(pairRow).join("");
  wirePairs();
  f.querySelector("#add-pair").onclick = () => {
    if (pairsBox.querySelectorAll(".pair-row").length >= 30) return;
    pairsBox.insertAdjacentHTML("beforeend", pairRow());
    wirePairs();
    pairsBox.lastElementChild.querySelector("textarea").focus();
  };
  const readGuide = () => {
    const pairs = [...pairsBox.querySelectorAll(".pair-row")]
      .map((r) => ({ if: r.querySelector("[data-if]").value.trim(), say: r.querySelector("[data-say]").value.trim() }))
      .filter((p) => p.if || p.say).slice(0, 30);
    const notes = f.guide_notes.value.trim();
    return notes || pairs.length ? { notes, pairs } : {};
  };

  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector("#err");
    const config = locked ? { ...act.config } : { ...KINDS[kind].read(f) };
    config.group = f.group.value;
    const problem = locked ? null : KINDS[kind].check(config);
    if (problem) { err.textContent = problem; return; }
    const row = { title: f.title.value.trim(), prompt: f.prompt.value.trim(), config, guide: readGuide() };
    try {
      if (act) {
        must(await sb.from("activities").update(row).eq("id", act.id));
        location.hash = `#/a/${act.id}`;
      } else {
        const { count: n } = await sb.from("activities").select("id", { count: "exact", head: true }).eq("space_id", space.id);
        must(await sb.from("activities").insert({ ...row, kind, space_id: space.id, position: n || 0 }));
        store.set("cs.lastKind", kind);
        location.hash = `#/s/${space.id}`;
      }
    } catch (x) { err.textContent = errorText(x); }
  };
  f.querySelector("#del")?.addEventListener("click", async () => {
    if (!confirm(`Delete "${act.title}"? It has no responses.`)) return;
    must(await sb.from("activities").delete().eq("id", act.id));
    location.hash = `#/s/${space.id}`;
  });
}

// ---------------------------------------------------------------- results

async function loadActivity(id) {
  const act = must(await sb.from("activities").select("*").eq("id", id).single());
  const space = must(await sb.from("spaces").select("*").eq("id", act.space_id).single());
  return { act, space };
}

const loadResponses = (activityId) => fetchAll(() => sb.from("responses")
  .select("id, body, group_label, device, hidden, picked, created_at, updated_at").eq("activity_id", activityId)
  .order("created_at").order("id"));

function responseText(act, r) {
  const c = act.config || {};
  if (act.kind === "card") return (r.body.tag ? `[${r.body.tag}] ` : "") + r.body.text;
  if (act.kind === "poll") return c.options?.[r.body.choice] ?? r.body.choice;
  if (act.kind === "scale") return String(r.body.value);
  if (act.kind === "sort") {
    return (c.items || []).map((it, i) => {
      const j = (r.body.placements || [])[i];
      return j === null || j === undefined ? null : `${it}: ${c.buckets?.[j]}`;
    }).filter(Boolean).join("; ");
  }
  if (act.kind === "vote") {
    return `Round ${r.body.round || 1}: ${c.options?.[r.body.choice] ?? r.body.choice}` + (r.body.confidence ? ` (sure ${r.body.confidence}/3)` : "");
  }
  if (act.kind === "dots") return `${(r.body.picks || []).length} vote(s)`;
  if (act.kind === "slider") return `${r.body.value} of 100`;
  if (act.kind === "qa") return r.body.upvote ? "▲ upvote" : r.body.text;
  if (act.kind === "rank") return (r.body.order || []).map((i, k) => `${k + 1}. ${c.items?.[i] ?? i}`).join("  ");
  if (act.kind === "quiz") return `${r.body.correct ? "Right" : "Wrong"}: ${r.body.answer}`;
  if (act.kind === "hotspot") return (r.body.points || []).map((p) => `(${p.x}, ${p.y})`).join(" ");
  if (act.kind === "ticket") return `${r.body.value}: ${r.body.text}`;
  return JSON.stringify(r.body);
}

// Data a chart needs beyond its own responses: dot voting reads its source cards.
async function loadExtra(act) {
  if (act.kind !== "dots" || !act.config?.source) return {};
  const src = must(await sb.from("activities").select("id").eq("space_id", act.space_id)
    .eq("code", act.config.source).eq("kind", "card").maybeSingle());
  if (!src) return { cards: [] };
  const rs = await loadResponses(src.id);
  return { cards: rs.filter((r) => !r.hidden).map((r) => ({ id: r.id, text: r.body.text, tag: r.body.tag })) };
}

// Vote, discuss, vote again: move the activity between round 1 and round 2.
async function flipRound(act) {
  const round = act.config?.round === 2 ? 1 : 2;
  return must(await sb.from("activities").update({ config: { ...act.config, round } }).eq("id", act.id).select().single());
}
const roundLabel = (act) => (act.config?.round === 2 ? "Back to round 1" : "Start round 2");

// Tim's private answer guide (activities.guide), shown on the admin page only, never projected.
function guideHtml(act) {
  const g = act.guide || {};
  const pairs = (g.pairs || []).filter((p) => p.if || p.say);
  if (!g.notes && !pairs.length) {
    return `<p class="muted small guide-empty">No answer guide yet. <a href="#/e/${act.id}">Add one</a>: what students might say, and how you might answer.</p>`;
  }
  return `<details class="panel guide" open>
    <summary>Answer guide <span class="muted small">only you see this · <a href="#/e/${act.id}">edit</a></span></summary>
    ${g.notes ? `<p class="guide-notes">${esc(g.notes)}</p>` : ""}
    ${pairs.length ? `<dl class="guide-pairs">${pairs.map((p) => `
      <div class="guide-pair"><dt>If they say</dt><dd class="guide-if">${esc(p.if)}</dd>
        <dt>You might say</dt><dd class="guide-say">${esc(p.say)}</dd></div>`).join("")}</dl>` : ""}
  </details>`;
}

async function showResults(id) {
  let { act, space } = await loadActivity(id);
  const url = studentUrl(act.code);
  app.innerHTML = `${nav(` / <a href="#/s/${space.id}">${esc(space.title)}</a> / ${esc(act.title)}`)}
    <div class="page">
      <div class="head-row"><div>
          <span class="badge">${esc(KINDS[act.kind].label)}</span>
          <h1>${esc(act.title)}</h1>
          ${act.prompt ? `<p class="prompt">${esc(act.prompt)}</p>` : ""}
          <p class="muted small"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(shortLabel(url))}</a> · code <strong>${esc(act.code)}</strong></p>
        </div>
        <div class="btns">
          <button id="toggle"></button>
          ${act.kind === "vote" ? `<button id="round"></button>` : ""}
          <a class="button" href="#/p/${act.id}">Projector</a>
          <button id="qr">QR</button>
          <a class="button" href="#/e/${act.id}">Edit</a>
          <button id="csv">CSV</button>
          <button id="json">JSON</button>
          <button id="wipe" class="danger">Delete all posts</button>
        </div></div>
      ${guideHtml(act)}
      <section class="panel results" id="chart"></section>
      <h2>Responses</h2>
      ${PICKABLE.has(act.kind) ? `<div class="screen-mode" role="group" aria-label="What the projector shows">
        <span>On screen:</span>
        <button data-screen="all">All posts</button>
        <button data-screen="picked">Only the ones I pick</button>
        <span class="muted small" id="pick-n"></span>
      </div>` : ""}
      <table class="resp"><thead><tr><th>Time</th><th>Group</th><th>Response</th><th></th></tr></thead><tbody id="rows"></tbody></table>
    </div>`;
  wireNav();
  let responses = [];
  const toggle = app.querySelector("#toggle");
  const drawToggle = () => {
    toggle.textContent = act.is_open ? "Close" : "Open";
    toggle.className = act.is_open ? "danger" : "primary";
  };
  drawToggle();
  toggle.onclick = async () => {
    act = must(await sb.from("activities").update({ is_open: !act.is_open }).eq("id", act.id).select().single());
    drawToggle();
  };
  const roundBtn = app.querySelector("#round");
  if (roundBtn) {
    roundBtn.textContent = roundLabel(act);
    roundBtn.onclick = async () => { act = await flipRound(act); roundBtn.textContent = roundLabel(act); draw(); };
  }
  app.querySelector("#qr").onclick = () => showQr(act.code, act.title);
  app.querySelector("#csv").onclick = () => download(`${slug(space.title)}-${act.code}.csv`,
    toCsv(activityCsvRows(space, act, responses)), "text/csv");
  app.querySelector("#json").onclick = () => download(`${slug(space.title)}-${act.code}.json`,
    JSON.stringify(exportShape(space, [{ ...act, responses: responses }]), null, 2), "application/json");
  app.querySelector("#wipe").onclick = () => confirmWipe(act, responses.length, () => draw());

  // Picking for the screen (cards, question queue): the projector, on any device, shows only
  // picked posts while the activity's screen mode is "picked". Picking the first post switches it.
  const pickable = PICKABLE.has(act.kind);
  const setScreen = async (mode) => {
    act = must(await sb.from("activities").update({ screen: mode }).eq("id", act.id).select().single());
    drawScreen();
  };
  const drawScreen = () => {
    if (!pickable) return;
    app.querySelectorAll("[data-screen]").forEach((b) => {
      b.classList.toggle("on", b.dataset.screen === act.screen);
      b.setAttribute("aria-pressed", String(b.dataset.screen === act.screen));
    });
    const posts = responses.filter((r) => !r.hidden && !r.body?.upvote);
    const k = posts.filter((r) => r.picked).length;
    app.querySelector("#pick-n").textContent = act.screen === "picked"
      ? `${k} of ${posts.length} picked; only those are on screen`
      : `all ${posts.length} visible posts are on screen${k ? ` (${k} picked, for when you switch)` : ""}`;
  };
  app.querySelectorAll("[data-screen]").forEach((b) => b.onclick = () => setScreen(b.dataset.screen));

  const draw = async () => {
    responses = await loadResponses(act.id);
    app.querySelector("#chart").innerHTML = renderResults(act, responses, { extra: await loadExtra(act) });
    app.querySelector("#rows").innerHTML = [...responses].reverse().map((r) => `
      <tr class="${r.hidden ? "hidden-resp" : ""} ${r.picked && !r.hidden ? "picked-resp" : ""}">
        <td class="nowrap">${fmtTime(r.created_at)}</td>
        <td>${esc(r.group_label || "")}</td>
        <td>${esc(responseText(act, r))}</td>
        <td class="row-btns">${pickable && !r.body?.upvote ? `<button class="small pick ${r.picked ? "on" : ""}" data-pick="${r.id}"
              data-to="${!r.picked}" aria-pressed="${r.picked}" ${r.hidden ? "disabled" : ""}>${r.picked ? "On screen ✓" : "Pick"}</button>` : ""}
          <button class="small" data-hide="${r.id}" data-to="${!r.hidden}">${r.hidden ? "Unhide" : "Hide"}</button></td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">None yet.</td></tr>`;
    app.querySelectorAll("[data-hide]").forEach((b) => b.onclick = async () => {
      must(await sb.from("responses").update({ hidden: b.dataset.to === "true" }).eq("id", b.dataset.hide));
      draw();
    });
    app.querySelectorAll("[data-pick]").forEach((b) => b.onclick = async () => {
      const on = b.dataset.to === "true";
      must(await sb.from("responses").update({ picked: on }).eq("id", b.dataset.pick));
      if (on && act.screen !== "picked") await setScreen("picked");
      draw();
    });
    drawScreen();
  };
  await draw();
  liveTimer = setInterval(() => draw().catch(console.error), LIVE_MS);
}

// Permanently delete every post in one activity (for clearing test posts). The database
// allows it only for the admin and only while the activity is closed (delete_responses in schema.sql).
function confirmWipe(act, count, done) {
  const closedFirst = act.is_open
    ? `<p class="error">This activity is open. Close it first, so nobody posts while you delete.</p>` : "";
  dlg.innerHTML = `<form method="dialog" class="stack-form" id="wf">
    <h2>Delete all posts?</h2>
    <p>This permanently deletes all <strong>${count}</strong> post${count === 1 ? "" : "s"} in
      <strong>${esc(act.title)}</strong> (code ${esc(act.code)}). It cannot be undone. Download a CSV first if you might want them.</p>
    ${closedFirst}
    <label>Type <strong>delete</strong> to confirm<input name="word" autocomplete="off" ${act.is_open ? "disabled" : ""}></label>
    <p id="werr" class="error"></p>
    <div class="btns"><button value="cancel" formnovalidate>Cancel</button>
      <button value="go" class="danger" ${act.is_open ? "disabled" : ""}>Delete all posts</button></div>
  </form>`;
  const f = dlg.querySelector("#wf");
  f.onsubmit = async (e) => {
    if (e.submitter?.value !== "go") return;
    e.preventDefault();
    if (f.word.value.trim().toLowerCase() !== "delete") { f.querySelector("#werr").textContent = 'Type "delete" to confirm.'; return; }
    const { error } = await sb.rpc("delete_responses", { p_activity: act.id });
    if (error) { f.querySelector("#werr").textContent = error.message; return; }
    dlg.close();
    done();
  };
  dlg.showModal();
}

// ---------------------------------------------------------------- projector

async function showProjector(id) {
  let { act } = await loadActivity(id);
  const url = studentUrl(act.code);
  const pref = (k, d) => store.get(`cs.proj.${act.id}.${k}`, d);
  let showQrPanel = pref("qr", true);
  let showRes = pref("res", act.kind !== "card");
  let showNames = pref("names", false);
  document.body.classList.add("projecting");
  app.innerHTML = `
    <div class="proj">
      <div class="proj-tools">
        <a href="#/a/${act.id}" class="button">Exit</a>
        <button id="t-open"></button>
        <button id="t-qr">QR (Q)</button>
        <button id="t-res"></button>
        ${act.kind === "card" ? `<button id="t-names">Group names (N)</button>` : ""}
        ${act.kind === "vote" ? `<button id="t-round"></button>` : ""}
        <button id="t-fs">Full screen (F)</button>
      </div>
      <div class="proj-body">
        <div class="proj-main">
          <h1 class="proj-title">${esc(act.title)}</h1>
          ${act.prompt ? `<p class="proj-prompt">${esc(act.prompt)}</p>` : ""}
          <div class="proj-status" id="status"></div>
          <section class="results big" id="pres"></section>
          <p class="res-hidden muted" id="pres-off">Responses are hidden. Press R or Show responses to put them on screen.</p>
        </div>
        <aside class="proj-qr" id="pqr">
          <div class="qr">${qrSvg(url, 10)}</div>
          <div class="proj-url">${esc(shortLabel(url))}</div>
        </aside>
      </div>
    </div>`;
  const layout = () => {
    app.querySelector("#pqr").hidden = !showQrPanel;
    app.querySelector("#pres").hidden = !showRes;
    app.querySelector("#pres-off").hidden = showRes;
    app.querySelector("#t-qr").classList.toggle("on", showQrPanel);
    app.querySelector("#t-res").classList.toggle("on", showRes);
    app.querySelector("#t-res").textContent = showRes ? "Hide responses (R)" : "Show responses (R)";
    app.querySelector("#t-names")?.classList.toggle("on", showNames);
    app.querySelector(".proj-body").classList.toggle("no-qr", !showQrPanel);
    const b = app.querySelector("#t-open");
    b.textContent = act.is_open ? "Close" : "Open";
    b.className = act.is_open ? "danger" : "primary";
  };
  const flip = (k) => {
    if (k === "qr") { showQrPanel = !showQrPanel; store.set(`cs.proj.${act.id}.qr`, showQrPanel); }
    if (k === "res") { showRes = !showRes; store.set(`cs.proj.${act.id}.res`, showRes); }
    if (k === "names") { showNames = !showNames; store.set(`cs.proj.${act.id}.names`, showNames); draw(); }
    layout();
  };
  app.querySelector("#t-qr").onclick = () => flip("qr");
  app.querySelector("#t-res").onclick = () => flip("res");
  const tn = app.querySelector("#t-names");
  if (tn) tn.onclick = () => flip("names");
  const tr = app.querySelector("#t-round");
  if (tr) {
    tr.textContent = roundLabel(act);
    tr.onclick = async () => { act = await flipRound(act); tr.textContent = roundLabel(act); draw(); };
  }
  app.querySelector("#t-fs").onclick = fullscreen;
  app.querySelector("#t-open").onclick = async () => {
    act = must(await sb.from("activities").update({ is_open: !act.is_open }).eq("id", act.id).select().single());
    layout();
    draw();
  };
  const onKey = (e) => {
    if (!document.body.classList.contains("projecting")) { document.removeEventListener("keydown", onKey); return; }
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "q" || e.key === "Q") flip("qr");
    if (e.key === "r" || e.key === "R") flip("res");
    if ((e.key === "n" || e.key === "N") && act.kind === "card") flip("names");
    if (e.key === "f" || e.key === "F") fullscreen();
  };
  document.addEventListener("keydown", onKey);
  layout();

  const draw = async () => {
    const fresh = must(await sb.from("activities").select("is_open, screen, config").eq("id", act.id).single());
    const reopened = fresh.is_open !== act.is_open;
    act = { ...act, ...fresh };
    if (reopened) layout();
    const responses = await loadResponses(act.id);
    app.querySelector("#status").innerHTML = `${act.is_open ? `<span class="pill open">Open</span>` : `<span class="pill">Closed</span>`}
      <span>${screenCount(act, responses)}</span>`;
    // Group labels stay off the projector unless the Names toggle is on (cards only).
    app.querySelector("#pres").innerHTML = screenResults(act, responses, { names: showNames, extra: await loadExtra(act) });
  };
  await draw();
  liveTimer = setInterval(() => draw().catch(console.error), LIVE_MS);
}

// ---------------------------------------------------------------- class view
// One browser tab for a whole class: a tab per activity (green when open, with a live response
// count), and the chosen activity in projector style below. Arrow keys move between tabs.

async function showClass(spaceId, actId) {
  const space = must(await sb.from("spaces").select("*").eq("id", spaceId).single());
  const loadActs = async () => must(await sb.from("activities")
    .select("id, code, kind, title, prompt, config, is_open, screen, position, space_id, created_at, responses(count)")
    .eq("space_id", spaceId).eq("responses.hidden", false).order("position").order("created_at"));
  let acts = await loadActs();
  if (!acts.length) { location.hash = `#/s/${spaceId}`; return; }
  let act = acts.find((a) => a.id === actId) || acts.find((a) => a.is_open) || acts[0];
  if (act.id !== actId) history.replaceState(null, "", `#/c/${spaceId}/${act.id}`);
  const joinUrl = space.code ? studentUrl(space.code) : studentUrl(act.code);
  const pref = (k, d) => store.get(`cs.class.${k}`, d);
  let showQrPanel = pref("qr", true);
  let showRes = pref("res", true);
  let showNames = store.get(`cs.proj.${act.id}.names`, false);
  document.body.classList.add("projecting");
  app.innerHTML = `
    <div class="proj class-view">
      <div class="ctop">
        <nav class="ctabs" id="tabs" role="tablist" aria-label="Activities"></nav>
        <div class="proj-tools">
          <a href="#/s/${spaceId}" class="button">Manage</a>
          <a href="#/a/${act.id}" target="_blank" rel="noopener" class="button"
             title="Admin page in a new browser tab: group names, hide, export. Not for the projector.">Moderate ↗</a>
          <button id="t-open"></button>
          <button id="t-qr">QR (Q)</button>
          <button id="t-res"></button>
          ${act.kind === "card" ? `<button id="t-names">Group names (N)</button>` : ""}
          ${act.kind === "vote" ? `<button id="t-round"></button>` : ""}
          <button id="t-fs">Full screen (F)</button>
        </div>
      </div>
      <div class="proj-body">
        <div class="proj-main">
          <h1 class="proj-title">${esc(act.title)}</h1>
          ${act.prompt ? `<p class="proj-prompt">${esc(act.prompt)}</p>` : ""}
          <div class="proj-status" id="status"></div>
          <section class="results big" id="pres"></section>
          <p class="res-hidden muted" id="pres-off">Responses are hidden. Press R or Show responses to put them on screen.</p>
        </div>
        <aside class="proj-qr" id="pqr">
          <div class="qr">${qrSvg(joinUrl, 10)}</div>
          <div class="proj-url">${esc(shortLabel(joinUrl))}</div>
          ${space.code ? `<div class="proj-codes">Join code <strong>${esc(space.code)}</strong><br><span class="muted">this activity: ${esc(act.code)}</span></div>` : ""}
        </aside>
      </div>
    </div>`;
  const count = (a) => a.responses?.[0]?.count ?? 0;
  const drawTabs = () => {
    app.querySelector("#tabs").innerHTML = acts.map((a, i) => `
      <a role="tab" href="#/c/${spaceId}/${a.id}" class="ctab ${a.is_open ? "open" : ""} ${a.id === act.id ? "on" : ""}"
         aria-selected="${a.id === act.id}" title="${esc(a.title)} (code ${esc(a.code)})">
        <span class="ctab-top">
          <span class="ctab-state">${a.is_open ? "Open" : "Closed"}</span>
          <span class="ctab-n"><strong>${count(a)}</strong> ${count(a) === 1 ? "post" : "posts"}</span>
        </span>
        <span class="ctab-title"><span class="ctab-num">${i + 1}</span>${esc(a.title)}</span>
      </a>`).join("");
  };
  const layout = () => {
    app.querySelector("#pqr").hidden = !showQrPanel;
    app.querySelector("#pres").hidden = !showRes;
    app.querySelector("#pres-off").hidden = showRes;
    app.querySelector("#t-qr").classList.toggle("on", showQrPanel);
    app.querySelector("#t-res").classList.toggle("on", showRes);
    app.querySelector("#t-res").textContent = showRes ? "Hide responses (R)" : "Show responses (R)";
    app.querySelector("#t-names")?.classList.toggle("on", showNames);
    app.querySelector(".proj-body").classList.toggle("no-qr", !showQrPanel);
    const b = app.querySelector("#t-open");
    b.textContent = act.is_open ? "Close" : "Open";
    b.className = act.is_open ? "danger" : "primary";
  };
  const flip = (k) => {
    if (k === "qr") { showQrPanel = !showQrPanel; store.set("cs.class.qr", showQrPanel); }
    if (k === "res") { showRes = !showRes; store.set("cs.class.res", showRes); }
    if (k === "names") { showNames = !showNames; store.set(`cs.proj.${act.id}.names`, showNames); draw(); }
    layout();
  };
  app.querySelector("#t-qr").onclick = () => flip("qr");
  app.querySelector("#t-res").onclick = () => flip("res");
  const tn = app.querySelector("#t-names");
  if (tn) tn.onclick = () => flip("names");
  const tr = app.querySelector("#t-round");
  if (tr) {
    tr.textContent = roundLabel(act);
    tr.onclick = async () => { act = { ...act, ...(await flipRound(act)) }; tr.textContent = roundLabel(act); draw(); };
  }
  app.querySelector("#t-fs").onclick = fullscreen;
  app.querySelector("#t-open").onclick = async () => {
    const row = must(await sb.from("activities").update({ is_open: !act.is_open }).eq("id", act.id).select().single());
    act = { ...act, ...row };
    acts = acts.map((a) => (a.id === act.id ? { ...a, is_open: act.is_open } : a));
    layout();
    drawTabs();
    draw();
  };
  const onKey = (e) => {
    if (!app.querySelector(".class-view")) { document.removeEventListener("keydown", onKey); return; }
    if (e.target.closest("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const i = acts.findIndex((a) => a.id === act.id);
    if (e.key === "ArrowRight" && i < acts.length - 1) location.hash = `#/c/${spaceId}/${acts[i + 1].id}`;
    if (e.key === "ArrowLeft" && i > 0) location.hash = `#/c/${spaceId}/${acts[i - 1].id}`;
    if (e.key === "q" || e.key === "Q") flip("qr");
    if (e.key === "r" || e.key === "R") flip("res");
    if ((e.key === "n" || e.key === "N") && act.kind === "card") flip("names");
    if (e.key === "f" || e.key === "F") fullscreen();
  };
  document.addEventListener("keydown", onKey);
  drawTabs();
  layout();

  const draw = async () => {
    const responses = await loadResponses(act.id);
    app.querySelector("#status").innerHTML = `${act.is_open ? `<span class="pill open">Open</span>` : `<span class="pill">Closed</span>`}
      <span>${screenCount(act, responses)}</span><span class="muted">code ${esc(act.code)}</span>`;
    app.querySelector("#pres").innerHTML = screenResults(act, responses, { names: showNames, extra: await loadExtra(act) });
  };
  const tick = async () => {
    acts = await loadActs();
    const fresh = acts.find((a) => a.id === act.id);
    if (fresh) {
      const changed = fresh.is_open !== act.is_open;
      act = { ...act, ...fresh };
      if (changed) layout();
    }
    drawTabs();
    await draw();
  };
  await draw();
  liveTimer = setInterval(() => tick().catch(console.error), LIVE_MS);
}

// What the projected views show, and their count line, honouring "Only picked" (activities.screen).
const picking = (act) => act.screen === "picked" && PICKABLE.has(act.kind);
function screenCount(act, responses) {
  const n = responses.filter((r) => !r.hidden && !r.body?.upvote).length;
  if (!picking(act)) return `${n} response${n === 1 ? "" : "s"}`;
  const k = forScreen(act, responses).filter((r) => !r.body?.upvote).length;
  return `${k} of ${n} on screen`;
}
function screenResults(act, responses, opts) {
  const rows = forScreen(act, responses);
  if (picking(act) && !rows.some((r) => !r.body?.upvote)) {
    return `<p class="res-hidden muted">Nothing picked yet. Pick posts on the admin page and they appear here.</p>`;
  }
  return renderResults(act, rows, { big: true, ...opts });
}

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// ---------------------------------------------------------------- export

function exportShape(space, acts) {
  return {
    exported_at: new Date().toISOString(),
    space: { id: space.id, title: space.title, course: space.course, meets_on: space.meets_on },
    activities: acts.map((a) => ({
      id: a.id, code: a.code, kind: a.kind, title: a.title, prompt: a.prompt, config: a.config, guide: a.guide || {},
      opened_at: a.opened_at, closed_at: a.closed_at,
      responses: a.responses.map((r) => ({
        created_at: r.created_at, updated_at: r.updated_at, group: r.group_label, hidden: r.hidden, body: r.body,
      })),
    })),
  };
}

async function exportSpaceJson(space, acts) {
  const full = [];
  for (const a of acts) full.push({ ...a, responses: await loadResponses(a.id) });
  download(`${space.meets_on || "space"}-${slug(space.title)}.json`,
    JSON.stringify(exportShape(space, full), null, 2), "application/json");
}
