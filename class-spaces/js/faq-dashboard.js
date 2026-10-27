// Admin: the FAQ assistant dashboard (#/faq). Settings, usage, timing, ratings, and the full
// question log with a review status, so unanswered questions can go back into the FAQ.

import { esc, qrSvg, shortLabel, fetchAll, errorText } from "./common.js";

// Estimated price per million tokens (Claude Haiku class). Only for the cost estimate; the
// Anthropic console has the real bill.
const PRICE = { input: 1.0, cacheRead: 0.1, cacheWrite: 1.25, output: 5.0 };
const TZ = "America/New_York";
const STATUSES = ["new", "reviewed", "added", "ignored"];
const PAGE_ROWS = 200;

let state = null;

export async function showFaq(ctx) {
  const { app, sb } = ctx;
  const range = ctx.store.get("faq.range", "7");
  const since = range === "all" ? null : new Date(Date.now() - Number(range) * 86400000).toISOString();
  const [settings, questions, sessions] = await Promise.all([
    sb.from("faq_settings").select("*").eq("id", 1).maybeSingle().then(ctx.must),
    fetchAll(() => { let q = sb.from("faq_questions").select("*").order("asked_at", { ascending: false }); return since ? q.gte("asked_at", since) : q; }),
    fetchAll(() => { let q = sb.from("faq_sessions").select("*").order("started_at", { ascending: false }); return since ? q.gte("started_at", since) : q; }),
  ]);
  state = { ctx, settings, questions, sessions, range, filter: state?.filter || "all", search: state?.search || "", shown: PAGE_ROWS };
  render();
}

function render() {
  const { ctx, settings, questions, sessions, range } = state;
  const s = settings || {};
  const titles = new Map((s.faq_entries || []).map((e) => [e.id, e.q]));
  const link = new URL("ask.html", location.href);
  link.search = s.join_code ? `?${s.join_code}` : "";
  ctx.app.innerHTML = `${ctx.nav(` / <span>FAQ assistant</span>`)}
  <div class="head-row">
    <div><h1>FAQ assistant</h1>
      <p class="muted small">Questions are logged without names. Times are Amherst time.</p></div>
    <div class="btns">
      <label class="small">Period <select id="range">
        ${[["1", "Last 24 hours"], ["7", "Last 7 days"], ["30", "Last 30 days"], ["all", "Everything"]]
          .map(([v, l]) => `<option value="${v}" ${v === range ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <button id="reload">Refresh</button>
    </div>
  </div>
  ${settingsHtml(s, link.href)}
  ${kpisHtml(questions, sessions)}
  <div class="cols-2">
    <div class="panel"><h3>Questions per day</h3>${perDayHtml(questions, range)}</div>
    <div class="panel"><h3>When students ask (hour of day)</h3>${perHourHtml(questions)}</div>
  </div>
  <div class="cols-2">
    <div class="panel"><h3>FAQ entries used most</h3>${topEntriesHtml(questions, titles)}</div>
    <div class="panel"><h3>Devices</h3>${devicesHtml(sessions)}
      <h3 style="margin-top:16px">Answer time</h3>${latencyHtml(questions)}</div>
  </div>
  <div class="panel" id="log-panel">${logHtml(titles)}</div>`;
  ctx.wireNav();
  wire(s);
}

// ---------------------------------------------------------------- numbers

const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const pct = (xs, p) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)]; };
const fmtPct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : "–");
const fmtSecs = (ms) => (ms == null ? "–" : ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const fmtMins = (ms) => (ms == null ? "–" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60000).toFixed(1)} min`);
const dayKey = (t) => new Date(t).toLocaleDateString("en-CA", { timeZone: TZ });
const hourOf = (t) => Number(new Date(t).toLocaleString("en-US", { hour: "numeric", hourCycle: "h23", timeZone: TZ }));
const visitLen = (v) => new Date(v.last_seen_at) - new Date(v.started_at);

export function stats(questions, sessions) {
  const answered = questions.filter((q) => !q.error);
  const rated = answered.filter((q) => q.rating != null);
  const lat = answered.map((q) => q.latency_ms).filter((x) => x != null);
  const withQ = sessions.filter((v) => v.questions > 0);
  const tok = (k) => answered.reduce((a, q) => a + (q[k] || 0), 0);
  const cost = (tok("input_tokens") * PRICE.input + tok("cache_read_tokens") * PRICE.cacheRead
    + tok("cache_write_tokens") * PRICE.cacheWrite + tok("output_tokens") * PRICE.output) / 1e6;
  return {
    questions: questions.length,
    answered: answered.length,
    visits: sessions.length,
    devices: new Set([...questions.map((q) => q.device), ...sessions.map((v) => v.device)]).size,
    perVisit: withQ.length ? withQ.reduce((a, v) => a + v.questions, 0) / withQ.length : null,
    visitMedian: median(sessions.map(visitLen)),
    visitMedianQ: median(withQ.map(visitLen)),
    latMedian: median(lat),
    lat95: pct(lat, 0.95),
    up: rated.filter((q) => q.rating === 1).length,
    down: rated.filter((q) => q.rating === -1).length,
    rated: rated.length,
    notCovered: answered.filter((q) => q.covered === false).length,
    declined: answered.filter((q) => q.declined).length,
    errors: questions.length - answered.length,
    followUps: questions.filter((q) => (q.turn || 1) > 1).length,
    noVisitQ: sessions.filter((v) => v.questions === 0).length,
    cost,
  };
}

function kpisHtml(questions, sessions) {
  const k = stats(questions, sessions);
  const tile = (v, l, title = "") => `<div class="kpi" ${title ? `title="${esc(title)}"` : ""}><div class="v">${v}</div><div class="l">${l}</div></div>`;
  return `<div class="kpis">
    ${tile(k.questions, "questions asked")}
    ${tile(k.visits, "visits", "A visit ends after 30 minutes away from the page")}
    ${tile(k.devices, "devices (about one per student)")}
    ${tile(k.perVisit == null ? "–" : k.perVisit.toFixed(1), "questions per visit (visits with a question)")}
    ${tile(fmtMins(k.visitMedianQ), "typical visit, when they asked (median)")}
    ${tile(fmtMins(k.visitMedian), "typical visit, all (median)", `${k.noVisitQ} visits asked nothing`)}
    ${tile(fmtSecs(k.latMedian), "answer time, median")}
    ${tile(fmtSecs(k.lat95), "answer time, slowest 5%")}
    ${tile(fmtPct(k.up, k.rated), `helpful (${k.up} 👍, ${k.down} 👎)`)}
    ${tile(fmtPct(k.rated, k.answered), "answers rated")}
    ${tile(fmtPct(k.notCovered, k.answered), `not in the FAQ (${k.notCovered})`)}
    ${tile(k.declined, "declined under the AI policy")}
    ${tile(fmtPct(k.followUps, k.questions), "follow-up questions")}
    ${tile(k.errors, "errors")}
    ${tile(`$${k.cost.toFixed(2)}`, "estimated cost", "From token counts at Haiku-class prices; the Anthropic console has the real bill")}
  </div>`;
}

function barsHtml(points, cls = "") {
  const max = Math.max(1, ...points.map((p) => p.n));
  return `<div class="chart ${cls}">${points.map((p) => `<div class="c" title="${esc(p.label)}: ${p.n}">
      <span class="n">${p.n || ""}</span>
      <div class="b" style="height:${(100 * p.n) / max}%"></div>
      <span class="t">${esc(p.short ?? p.label)}</span></div>`).join("")}</div>`;
}

function perDayHtml(questions, range) {
  const days = range === "all"
    ? Math.min(60, Math.max(7, Math.ceil((Date.now() - new Date(questions.at(-1)?.asked_at || Date.now())) / 86400000) + 1))
    : Math.max(1, Number(range));
  const counts = new Map();
  for (const q of questions) counts.set(dayKey(q.asked_at), (counts.get(dayKey(q.asked_at)) || 0) + 1);
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = dayKey(d);
    points.push({ label: d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: TZ }),
                  short: d.toLocaleDateString([], { month: "numeric", day: "numeric", timeZone: TZ }), n: counts.get(key) || 0 });
  }
  return questions.length ? barsHtml(points) : `<p class="muted">No questions yet.</p>`;
}

function perHourHtml(questions) {
  const n = Array(24).fill(0);
  for (const q of questions) n[hourOf(q.asked_at)]++;
  const lab = (h) => (h === 0 ? "12a" : h < 12 ? `${h}a` : h === 12 ? "12p" : `${h - 12}p`);
  return questions.length ? barsHtml(n.map((c, h) => ({ label: lab(h), short: h % 3 === 0 ? lab(h) : "", n: c }))) : `<p class="muted">No questions yet.</p>`;
}

function topEntriesHtml(questions, titles) {
  const m = new Map();
  for (const q of questions) for (const id of q.entries || []) {
    const e = m.get(id) || { n: 0, up: 0, down: 0 };
    e.n++; if (q.rating === 1) e.up++; if (q.rating === -1) e.down++;
    m.set(id, e);
  }
  const top = [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  if (!top.length) return `<p class="muted">None yet.</p>`;
  const max = top[0][1].n;
  return `<div class="bars">${top.map(([id, e]) => `<div class="bar-row">
      <span class="bar-label small" title="${esc(id)}">${esc(titles.get(id) || id)}</span>
      <div class="bar-track"><div class="bar" style="width:${(100 * e.n) / max}%"></div></div>
      <span class="bar-val small">${e.n}${e.up || e.down ? ` · ${e.up}👍 ${e.down}👎` : ""}</span></div>`).join("")}</div>`;
}

function devicesHtml(sessions) {
  const by = { phone: 0, tablet: 0, desktop: 0 };
  for (const v of sessions) if (v.kind in by) by[v.kind]++;
  const total = sessions.length;
  return total ? `<p>${Object.entries(by).map(([k, n]) => `${k}: <strong>${fmtPct(n, total)}</strong> (${n})`).join(" · ")}</p>`
    : `<p class="muted">No visits yet.</p>`;
}

function latencyHtml(questions) {
  const lat = questions.filter((q) => !q.error && q.latency_ms != null).map((q) => q.latency_ms / 1000);
  if (!lat.length) return `<p class="muted">No answers yet.</p>`;
  const buckets = [[0, 2, "<2s"], [2, 4, "2–4s"], [4, 6, "4–6s"], [6, 10, "6–10s"], [10, 1e9, "10s+"]];
  return barsHtml(buckets.map(([a, b, l]) => ({ label: l, n: lat.filter((x) => x >= a && x < b).length })));
}

// ---------------------------------------------------------------- the log

const needsAttention = (q) => q.review_status === "new" && (q.error || q.covered === false || q.rating === -1);
const FILTERS = {
  all: ["All", () => true],
  attn: ["Needs attention", needsAttention],
  new: ["Not reviewed", (q) => q.review_status === "new"],
  down: ["👎", (q) => q.rating === -1],
  up: ["👍", (q) => q.rating === 1],
  gap: ["Not in the FAQ", (q) => q.covered === false],
  declined: ["Declined", (q) => q.declined],
  errors: ["Errors", (q) => Boolean(q.error)],
};

function filtered() {
  const [, keep] = FILTERS[state.filter] || FILTERS.all;
  const s = state.search.toLowerCase();
  return state.questions.filter((q) => keep(q) && (!s || `${q.question} ${q.answer || ""} ${q.feedback || ""} ${q.review_note || ""}`.toLowerCase().includes(s)));
}

function logHtml(titles) {
  const rows = filtered();
  const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, [, f]]) => [k, state.questions.filter(f).length]));
  return `<div class="head-row"><h3>Questions</h3>
      <div class="btns"><button class="small" id="csv">Download CSV</button><button class="small" id="json">Download JSON</button></div></div>
    <div class="faq-filters">
      ${Object.entries(FILTERS).map(([k, [l]]) => `<button class="small ${state.filter === k ? "on" : ""}" data-filter="${k}">${l} (${counts[k]})</button>`).join("")}
      <input type="search" id="search" placeholder="Search questions, answers, feedback" value="${esc(state.search)}">
    </div>
    ${rows.length ? `<table class="resp faqq"><thead><tr><th>When</th><th>Question and answer</th><th>FAQ entries</th><th>Rating</th><th>Time</th><th>Review</th></tr></thead><tbody>
      ${rows.slice(0, state.shown).map((q) => rowHtml(q, titles)).join("")}</tbody></table>
      ${rows.length > state.shown ? `<p><button class="small" id="more">Show ${Math.min(PAGE_ROWS, rows.length - state.shown)} more of ${rows.length - state.shown}</button></p>` : ""}`
      : `<p class="muted">No questions match.</p>`}`;
}

function rowHtml(q, titles) {
  const when = new Date(q.asked_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  const tags = [
    q.error ? `<span class="tag bad">error</span>` : "",
    q.covered === false ? `<span class="tag bad">not in FAQ</span>` : "",
    q.declined ? `<span class="tag">declined</span>` : "",
    (q.turn || 1) > 1 ? `<span class="tag">follow-up</span>` : "",
  ].join("");
  return `<tr class="${needsAttention(q) ? "attn" : ""}" data-id="${q.id}">
    <td class="small nowrap">${esc(when)}</td>
    <td class="qa"><strong>${esc(q.question)}</strong> ${tags}
      <details><summary class="small muted">Answer</summary><div class="ans">${esc(q.error || q.answer || "")}</div></details></td>
    <td class="small">${(q.entries || []).map((id) => `<div>${esc(titles.get(id) || id)}</div>`).join("") || "–"}</td>
    <td class="small">${q.rating === 1 ? "👍" : q.rating === -1 ? "👎" : "–"}${q.feedback ? `<div class="ans">${esc(q.feedback)}</div>` : ""}</td>
    <td class="small nowrap">${fmtSecs(q.latency_ms)}</td>
    <td class="small"><select data-status>${STATUSES.map((s) => `<option ${s === q.review_status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input class="small" data-note placeholder="Note" value="${esc(q.review_note || "")}" style="margin-top:4px"></td>
  </tr>`;
}

// ---------------------------------------------------------------- settings

function settingsHtml(s, studentLink) {
  const updated = s.faq_updated_at ? new Date(s.faq_updated_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short", timeZone: TZ }) : "never";
  return `<div class="panel"><div class="head-row">
      <div>
        <p><span class="pill ${s.is_open ? "open" : ""}">${s.is_open ? "Open" : "Closed"}</span>
          Join code <strong class="space-code">${esc(s.join_code || "")}</strong></p>
        <p class="small"><a href="${esc(studentLink)}" target="_blank" rel="noopener">${esc(shortLabel(studentLink))}</a></p>
        <p class="small muted">Material: ${(s.faq_entries || []).filter((e) => e.kind !== "page").length} FAQ answers and ${(s.faq_entries || []).filter((e) => e.kind === "page").length} course page sections, version ${esc(s.faq_version || "–")}, loaded ${esc(updated)}.
          Model ${esc(s.model || "")}. Limits: ${s.per_device_hour}/hour and ${s.per_device_day}/day per device, ${s.daily_cap}/day in all.</p>
        <div class="btns">
          <button class="${s.is_open ? "" : "primary"}" id="toggle">${s.is_open ? "Close" : "Open"}</button>
          <button id="newcode">New join code</button>
          <button id="qr">QR code</button>
          <label class="button">Load FAQ file<input type="file" id="faqfile" accept=".json,application/json" hidden></label>
          <button id="limits">Limits and model</button>
        </div>
        <p class="error" id="set-err"></p>
      </div>
    </div></div>`;
}

function wire(s) {
  const { ctx } = state;
  const $ = (sel) => ctx.app.querySelector(sel);
  const err = (e) => { $("#set-err").textContent = errorText(e); };
  const save = async (patch) => {
    ctx.must(await ctx.sb.from("faq_settings").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", 1).select().single());
    await showFaq(ctx);
  };
  $("#range").onchange = (e) => { ctx.store.set("faq.range", e.target.value); showFaq(ctx).catch(ctx.fail); };
  $("#reload").onclick = () => showFaq(ctx).catch(ctx.fail);
  $("#toggle").onclick = () => save({ is_open: !s.is_open }).catch(err);
  $("#newcode").onclick = async () => {
    if (!confirm("Make a new join code? The old link stops working at once.")) return;
    const { data, error } = await ctx.sb.rpc("new_code");
    if (error) return err(error);
    save({ join_code: data }).catch(err);
  };
  $("#qr").onclick = () => {
    const link = new URL("ask.html", location.href); link.search = `?${s.join_code}`;
    ctx.dlg.innerHTML = `<div class="qr-dlg"><div class="qr">${qrSvg(link.href)}</div>
      <p class="qr-url">${esc(shortLabel(link.href))}</p><form method="dialog"><button>Close</button></form></div>`;
    ctx.dlg.showModal();
  };
  $("#faqfile").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      if (typeof doc.text !== "string" || !doc.text.trim() || !Array.isArray(doc.entries) || !doc.entries.length) {
        throw new Error("That is not an FAQ assistant file (it needs text and entries). Make it with export_for_notebook.py --assistant.");
      }
      if (!confirm(`Load this file: ${doc.entries.length} entries, version ${doc.version || "?"}? It replaces the current material at once.`)) return;
      await save({ faq_text: doc.text, faq_entries: doc.entries.map((x) => ({ id: String(x.id), q: String(x.q), section: x.section ? String(x.section) : null,
                                                         kind: x.kind === "page" ? "page" : "faq", url: x.url ? String(x.url) : null })),
                   faq_version: String(doc.version || f.name), faq_updated_at: new Date().toISOString() });
    } catch (x) { err(x); }
  };
  $("#limits").onclick = () => {
    ctx.dlg.innerHTML = `<form method="dialog" class="stack-form" id="lim">
      <h3>Limits and model</h3>
      <div class="row"><label>Per device, per hour<input type="number" name="h" min="1" max="200" value="${s.per_device_hour}"></label>
        <label>Per device, per day<input type="number" name="d" min="1" max="1000" value="${s.per_device_day}"></label></div>
      <label>Questions per day, everyone<input type="number" name="cap" min="1" max="20000" value="${s.daily_cap}"></label>
      <label>Model<input name="model" value="${esc(s.model)}"></label>
      <div class="btns"><button class="primary" value="save">Save</button><button value="cancel">Cancel</button></div></form>`;
    ctx.dlg.showModal();
    ctx.dlg.querySelector("#lim").onsubmit = (e) => {
      if (e.submitter?.value !== "save") return;
      const f = e.target;
      save({ per_device_hour: +f.h.value, per_device_day: +f.d.value, daily_cap: +f.cap.value, model: f.model.value.trim() }).catch(err);
    };
  };
  wireLog();
}

function wireLog() {
  const { ctx } = state;
  const panel = ctx.app.querySelector("#log-panel");
  const titles = new Map((state.settings?.faq_entries || []).map((e) => [e.id, e.q]));
  const redraw = () => { panel.innerHTML = logHtml(titles); wireLog(); };
  panel.querySelectorAll("[data-filter]").forEach((b) => { b.onclick = () => { state.filter = b.dataset.filter; state.shown = PAGE_ROWS; redraw(); }; });
  const search = panel.querySelector("#search");
  search.oninput = () => {
    state.search = search.value;
    clearTimeout(search.t);
    search.t = setTimeout(() => { redraw(); const s = panel.querySelector("#search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }, 250);
  };
  panel.querySelector("#more")?.addEventListener("click", () => { state.shown += PAGE_ROWS; redraw(); });
  panel.querySelectorAll("tr[data-id]").forEach((tr) => {
    const q = state.questions.find((x) => x.id === tr.dataset.id);
    const update = async (patch) => {
      const { error } = await ctx.sb.from("faq_questions").update({ ...patch, reviewed_at: new Date().toISOString() }).eq("id", q.id);
      if (error) return alert(errorText(error));
      Object.assign(q, patch);
      tr.classList.toggle("attn", needsAttention(q));
    };
    tr.querySelector("[data-status]").onchange = (e) => update({ review_status: e.target.value });
    tr.querySelector("[data-note]").onchange = (e) => update({ review_note: e.target.value.trim() || null });
  });
  panel.querySelector("#csv").onclick = () => ctx.download(`faq-questions-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(filtered()), "text/csv");
  panel.querySelector("#json").onclick = () => ctx.download(`faq-questions-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(filtered(), null, 2), "application/json");
}

const COLS = ["asked_at", "question", "answer", "entries", "covered", "declined", "rating", "feedback", "latency_ms", "turn",
  "review_status", "review_note", "error", "model", "input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "faq_version", "session_id", "id"];

export function toCsv(rows) {
  const cell = (v) => { const s = Array.isArray(v) ? v.join(" ") : v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [COLS.join(","), ...rows.map((r) => COLS.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}
