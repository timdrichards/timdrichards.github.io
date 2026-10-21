// Admin app: login, spaces, activities, results, projector, export.
// Routes (hash): #/  #/s/<space>  #/s/<space>/new  #/e/<activity>  #/a/<activity>  #/p/<activity>

import { sb, configured, esc, store, studentUrl, shortLabel, qrSvg, notConfiguredHtml, fetchAll, errorText } from "./common.js";
import { KINDS, renderResults, activityCsvRows, toCsv } from "./kinds.js";

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
  document.body.classList.remove("projecting");
  if (!session) return showLogin();
  if (!isAdmin) return showNotAdmin();
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [view, id, sub] = parts;
  const go = {
    s: () => (sub === "new" ? showActivityForm({ spaceId: id }) : showSpace(id)),
    e: () => showActivityForm({ activityId: id }),
    a: () => showResults(id),
    p: () => showProjector(id),
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
        <li><a href="#/s/${s.id}"><strong>${esc(s.title)}</strong></a>
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
        <p class="muted">${esc([space.course, fmtDate(space.meets_on)].filter(Boolean).join(" · "))}${space.archived ? " · archived" : ""}</p></div>
        <div class="btns">
          <a class="button primary" href="#/s/${id}/new">New activity</a>
          <button id="export-json">Export JSON</button>
          <button id="close-all">Close all</button>
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
          <option value="optional">Ask for an optional group label</option>
          <option value="off" ${act?.config?.group === "off" ? "selected" : ""}>Don't ask</option>
        </select></label>
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

  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector("#err");
    const config = locked ? { ...act.config } : { ...KINDS[kind].read(f) };
    config.group = f.group.value;
    const problem = locked ? null : KINDS[kind].check(config);
    if (problem) { err.textContent = problem; return; }
    const row = { title: f.title.value.trim(), prompt: f.prompt.value.trim(), config };
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
  .select("id, body, group_label, hidden, created_at, updated_at").eq("activity_id", activityId)
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
  return JSON.stringify(r.body);
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
          <a class="button" href="#/p/${act.id}">Projector</a>
          <button id="qr">QR</button>
          <a class="button" href="#/e/${act.id}">Edit</a>
          <button id="csv">CSV</button>
          <button id="json">JSON</button>
        </div></div>
      <section class="panel results" id="chart"></section>
      <h2>Responses</h2>
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
  app.querySelector("#qr").onclick = () => showQr(act.code, act.title);
  app.querySelector("#csv").onclick = () => download(`${slug(space.title)}-${act.code}.csv`,
    toCsv(activityCsvRows(space, act, responses)), "text/csv");
  app.querySelector("#json").onclick = () => download(`${slug(space.title)}-${act.code}.json`,
    JSON.stringify(exportShape(space, [{ ...act, responses: responses }]), null, 2), "application/json");

  const draw = async () => {
    responses = await loadResponses(act.id);
    app.querySelector("#chart").innerHTML = renderResults(act, responses);
    app.querySelector("#rows").innerHTML = [...responses].reverse().map((r) => `
      <tr class="${r.hidden ? "hidden-resp" : ""}">
        <td class="nowrap">${fmtTime(r.created_at)}</td>
        <td>${esc(r.group_label || "")}</td>
        <td>${esc(responseText(act, r))}</td>
        <td><button class="small" data-hide="${r.id}" data-to="${!r.hidden}">${r.hidden ? "Unhide" : "Hide"}</button></td>
      </tr>`).join("") || `<tr><td colspan="4" class="muted">None yet.</td></tr>`;
    app.querySelectorAll("[data-hide]").forEach((b) => b.onclick = async () => {
      must(await sb.from("responses").update({ hidden: b.dataset.to === "true" }).eq("id", b.dataset.hide));
      draw();
    });
  };
  await draw();
  liveTimer = setInterval(() => draw().catch(console.error), LIVE_MS);
}

// ---------------------------------------------------------------- projector

async function showProjector(id) {
  let { act } = await loadActivity(id);
  const url = studentUrl(act.code);
  const pref = (k, d) => store.get(`cs.proj.${act.id}.${k}`, d);
  let showQrPanel = pref("qr", true);
  let showRes = pref("res", act.kind !== "card");
  document.body.classList.add("projecting");
  app.innerHTML = `
    <div class="proj">
      <div class="proj-tools">
        <a href="#/a/${act.id}" class="button">Exit</a>
        <button id="t-open"></button>
        <button id="t-qr">QR (Q)</button>
        <button id="t-res">Results (R)</button>
        <button id="t-fs">Full screen (F)</button>
      </div>
      <div class="proj-body">
        <div class="proj-main">
          <h1 class="proj-title">${esc(act.title)}</h1>
          ${act.prompt ? `<p class="proj-prompt">${esc(act.prompt)}</p>` : ""}
          <div class="proj-status" id="status"></div>
          <section class="results big" id="pres"></section>
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
    app.querySelector("#t-qr").classList.toggle("on", showQrPanel);
    app.querySelector("#t-res").classList.toggle("on", showRes);
    app.querySelector(".proj-body").classList.toggle("no-qr", !showQrPanel);
    const b = app.querySelector("#t-open");
    b.textContent = act.is_open ? "Close" : "Open";
    b.className = act.is_open ? "danger" : "primary";
  };
  const flip = (k) => {
    if (k === "qr") { showQrPanel = !showQrPanel; store.set(`cs.proj.${act.id}.qr`, showQrPanel); }
    if (k === "res") { showRes = !showRes; store.set(`cs.proj.${act.id}.res`, showRes); }
    layout();
  };
  app.querySelector("#t-qr").onclick = () => flip("qr");
  app.querySelector("#t-res").onclick = () => flip("res");
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
    if (e.key === "f" || e.key === "F") fullscreen();
  };
  document.addEventListener("keydown", onKey);
  layout();

  const draw = async () => {
    const responses = await loadResponses(act.id);
    const n = responses.filter((r) => !r.hidden).length;
    app.querySelector("#status").innerHTML = act.is_open
      ? `<span class="pill open">Open</span> <span>${n} response${n === 1 ? "" : "s"}</span>`
      : `<span class="pill">Closed</span> <span>${n} response${n === 1 ? "" : "s"}</span>`;
    // No group labels on the projector: the chart and cards never show them.
    app.querySelector("#pres").innerHTML = renderResults(act, responses, { big: true });
  };
  await draw();
  liveTimer = setInterval(() => draw().catch(console.error), LIVE_MS);
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
      id: a.id, code: a.code, kind: a.kind, title: a.title, prompt: a.prompt, config: a.config,
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
