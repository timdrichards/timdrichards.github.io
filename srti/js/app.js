// SRTI Analyzer page. Everything happens in this tab: PDFs are read with a
// pinned copy of pdf.js and never leave the browser.

import * as pdfjs from "../vendor/pdf-4.10.38.min.js";
import { readReport, reportKey } from "./parse.js";
import { analyzeAll, DEFAULTS, TARGETS } from "./analyze.js";
import { SAMPLE_COURSE } from "./sample.js";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker-4.10.38.min.js", import.meta.url).href;

const state = { courses: new Map(), opts: { ...DEFAULTS }, open: new Set() };
const $ = (id) => document.getElementById(id);

// ---------- tiny DOM helper (text is always set as text, never HTML) ----------

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const f1 = (x) => (x == null || Number.isNaN(x) ? "–" : x.toFixed(1));
const f2 = (x) => (x == null || Number.isNaN(x) ? "–" : x.toFixed(2));
const signed = (x, d = 2) => (x == null ? "–" : (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(d));
const pc = (x) => (x == null ? "–" : `${Math.round(x * 100)}%`);
const cls = (x) => (x == null ? "" : x > 0.05 ? "pos" : x < -0.05 ? "neg" : "");

function setStatus(msg, error = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", error);
}

// ---------- loading ----------

function guessCredits(course) {
  return /\b198[A-Z]?\b/.test(course || "") ? 1 : DEFAULTS.credits;
}

async function addFiles(files) {
  const pdfs = [...files].filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
  if (!pdfs.length) return setStatus("Those were not PDFs. Add the SRTI PDFs from OAPA.", true);
  let ok = 0;
  const problems = [];
  for (const f of pdfs) {
    setStatus(`Reading ${f.name}…`);
    try {
      const r = await readReport(pdfjs, new Uint8Array(await f.arrayBuffer()));
      if (r.kind === "unknown" || !r.course) { problems.push(`${f.name} does not look like an SRTI Section Report or Open-Ended Responses PDF`); continue; }
      const key = reportKey(r);
      const c = state.courses.get(key) || { key, course: r.course, term: r.term, credits: guessCredits(r.course) };
      c[r.kind === "section" ? "section" : "open"] = r;
      state.courses.set(key, c);
      ok++;
    } catch (e) {
      console.error(e);
      problems.push(`${f.name} could not be read (${e.message || e})`);
    }
  }
  setStatus([ok ? `Read ${ok} PDF${ok === 1 ? "" : "s"}.` : "", ...problems].filter(Boolean).join(" "), problems.length > 0 && ok === 0);
  render();
}

function wireLoad() {
  const drop = $("drop");
  const input = $("files");
  drop.addEventListener("click", (e) => { if (e.target.tagName !== "LABEL") input.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
  input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
  $("sample").addEventListener("click", () => { state.courses.set(SAMPLE_COURSE.key, structuredClone(SAMPLE_COURSE)); setStatus("Loaded a made-up sample course."); render(); });
  $("clear").addEventListener("click", () => { state.courses.clear(); state.open.clear(); setStatus("Cleared."); render(); });
  $("print").addEventListener("click", () => window.print());
  $("json").addEventListener("click", downloadJSON);
}

// ---------- settings ----------

const SETTINGS = [
  ["tau", "τ: true spread of section means", "How much the real mean of an item varies between sections, on the 1 to 5 scale. Larger trusts small classes more.", 0.05, 0.05, 2],
  ["pLow", "Low-grade students who rate low", "Share of students expecting C+ or below who rate the course 1 or 2.", 0.01, 0, 1],
  ["pHigh", "Other students who rate low", "Share of everyone else who rates the course 1 or 2.", 0.01, 0, 1],
  ["themeBase", "Theme baseline", "Share of respondents expected to raise any one theme in a typical course.", 0.01, 0, 1],
  ["k0", "Shrinkage strength", "How many respondents' worth of weight the baseline gets. Larger pulls small classes harder toward it.", 1, 0, 100],
  ["recurMin", "Recurrence threshold", "A theme counts as present in a course when at least this share of respondents raise it.", 0.01, 0, 1],
];

function renderSettings() {
  const box = $("settings");
  box.replaceChildren(
    ...SETTINGS.map(([key, label, help, step, min, max]) =>
      h("div", { class: "setting" },
        h("label", { for: `opt-${key}` }, label),
        h("input", { id: `opt-${key}`, type: "number", step, min, max, value: state.opts[key], oninput: (e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) { state.opts[key] = v; render(); } } }),
        h("small", {}, help, ` Default ${DEFAULTS[key]}.`))),
  );
}

// ---------- rendering ----------

function render() {
  const courses = [...state.courses.values()];
  const any = courses.length > 0;
  ["clear", "print", "json"].forEach((id) => { $(id).hidden = !any; });
  const results = $("results");
  if (!any) { results.replaceChildren(); return; }
  const analyzed = analyzeAll(courses.map((c) => ({ ...c })), state.opts);
  state.last = analyzed;
  const kids = analyzed.map(courseCard);
  if (analyzed.length > 1) kids.push(acrossCourses(analyzed));
  results.replaceChildren(h("div", { class: "wrap wide" }, kids));
}

function courseCard(a) {
  const s = a.section || a.open || {};
  const title = `${a.course}${s.section ? `, section ${s.section}` : ""}`;
  const badges = [];
  if (a.sample) badges.push(h("span", { class: "badge sample" }, "Sample data, made up"));
  if (a.responseRate != null) badges.push(h("span", { class: "badge" }, `${s.responded} of ${s.enrolled} responded (${pc(a.responseRate)})${a.deptAvgResponse != null ? `, department average ${pc(a.deptAvgResponse)}` : ""}`));
  if (a.responseRate != null && a.responseRate < 0.3) badges.push(h("span", { class: "badge warn" }, "Low response rate: students with strong views are over-represented"));
  if (a.baseline.status === "passfail") badges.push(h("span", { class: "badge warn" }, "Looks pass/fail: no grade baseline"));
  if (a.respondentsWithText) badges.push(h("span", { class: "badge" }, `${a.respondentsWithText} written responses`));

  const credits = h("label", { class: "credits" }, "Credits: ",
    h("input", { type: "number", min: 1, max: 6, step: 1, value: a.credits, "aria-label": `Credits for ${title}`, oninput: (e) => { const v = Number(e.target.value); if (v > 0) { state.courses.get(a.key).credits = v; render(); } } }),
    " (used to judge reported hours)");

  return h("article", { class: "course-card" },
    h("h2", {}, title),
    h("p", { class: "course-sub" }, [s.term, s.instructor].filter(Boolean).join(" · ")),
    h("div", { class: "badges" }, badges),
    credits,
    a.warnings.map((w) => h("p", { class: "warning" }, w)),
    a.section ? itemsPanel(a) : null,
    a.section ? baselinePanel(a) : null,
    a.open ? themesPanel(a) : null,
  );
}

function itemsPanel(a) {
  const groupRows = a.groups.filter((g) => g.n).map((g) =>
    h("tr", {},
      h("td", {}, g.label),
      h("td", { class: "num" }, f2(g.mean)),
      h("td", { class: "num" }, f2(g.dept)),
      h("td", { class: `num ${cls(g.gap)}` }, signed(g.gap)),
      h("td", { class: "num" }, f2(g.lambda)),
      h("td", { class: `num ${cls(g.adjGap)}` }, signed(g.adjGap))));
  const itemRows = Object.values(a.stats).filter((s) => s.item <= 12).sort((x, y) => x.item - y.item).map((s) =>
    h("tr", {},
      h("td", {}, `${s.item}. ${s.label}`),
      h("td", { class: "num" }, s.n),
      h("td", { class: "num" }, f1(s.mean)),
      h("td", { class: "num" }, s.dept ? f1(s.dept.mean) : "–"),
      h("td", { class: `num ${cls(s.gap)}` }, signed(s.gap, 1)),
      h("td", { class: "num" }, f2(s.lambda)),
      h("td", { class: `num ${cls(s.adjGap)}` }, signed(s.adjGap)),
      h("td", { class: "num" }, pc(s.lowShare))));
  const dept = a.section.comparison && a.section.comparison.dept;
  return h("div", { class: "panel" },
    h("h3", {}, "Against the department"),
    h("p", { class: "explain" }, `Compared with ${dept && dept.name ? dept.name : "department"} sections of the same size band${dept && dept.sections ? ` (${dept.sections} sections)` : ""}. "Reliable gap" is the gap times λ, its reliability.`),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, h("th", {}, "Items"), h("th", { class: "num" }, "You"), h("th", { class: "num" }, "Dept"), h("th", { class: "num" }, "Gap"), h("th", { class: "num" }, "λ"), h("th", { class: "num" }, "Reliable gap"))),
      h("tbody", {}, groupRows))),
    h("details", {}, h("summary", {}, "Every item"),
      h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", {}, "Item"), h("th", { class: "num" }, "N"), h("th", { class: "num" }, "Mean"), h("th", { class: "num" }, "Dept"), h("th", { class: "num" }, "Gap"), h("th", { class: "num" }, "λ"), h("th", { class: "num" }, "Reliable gap"), h("th", { class: "num" }, "Rated 1–2"))),
        h("tbody", {}, itemRows)))),
  );
}

function baselinePanel(a) {
  const b = a.baseline;
  let body;
  if (b.status === "passfail") {
    body = [h("p", {}, `${pc(b.other)} of respondents chose "Other" for expected grade, so this looks like a pass/fail course. There is no grade spread to predict ratings from.`),
      h("p", { class: "explain" }, "A future version can use quiz and project scores instead. For now, read the comment themes and their corroboration.")];
  } else if (b.status !== "ok") {
    body = [h("p", {}, "The expected-grade question or the overall course rating is missing from this report, so there is no baseline.")];
  } else {
    const verdict = Math.abs(b.z) < 1.5
      ? "about what the grade mix predicts, so the low ratings carry little extra signal about teaching."
      : b.z > 0
        ? "more than the grade mix predicts: students who were doing fine also rated the course low. That is the more credible kind of complaint."
        : "fewer than the grade mix predicts: students were kinder than their grades suggest.";
    body = [
      h("p", {}, `About ${Math.round(b.lowGradeCount)} respondents expect C+ or lower (${pc(b.r)} of those giving a letter grade). The grade mix predicts ${pc(b.expected)} of students rating the course 1 or 2; ${pc(b.observed)} did (about ${Math.round(b.lowRatingCount)} of ${b.n}). That is `, h("strong", {}, verdict)),
      h("p", { class: "explain" }, `z = ${signed(b.z, 1)}. ${pc(b.aShare)} expect an A or A−; high grade expectations lift ratings on their own, so some of any gap above the department is leniency.`),
    ];
  }
  return h("div", { class: "panel" }, h("h3", {}, "Grade baseline"), h("div", { class: "baseline-box" }, body));
}

function highlight(ex, question) {
  const t = ex.text;
  return h("li", {},
    question ? h("span", { class: "q" }, `${question}: `) : null,
    t.slice(0, ex.index), h("mark", {}, t.slice(ex.index, ex.index + ex.length)), t.slice(ex.index + ex.length));
}

const SHORT_Q = ["Liked", "Change", "Suggestion", "Other comments"];

function themesPanel(a) {
  const max = Math.max(0.0001, ...a.themes.map((t) => t.signal));
  const rows = [];
  for (const t of a.themes) {
    if (!t.con && !t.pro) continue;
    const id = `${a.key}|${t.id}`;
    const isOpen = state.open.has(id);
    const toggle = () => { if (state.open.has(id)) state.open.delete(id); else state.open.add(id); render(); };
    rows.push(h("tr", { class: `theme-row${t.scored ? "" : " outside"}`, tabindex: 0, role: "button", "aria-expanded": isOpen ? "true" : "false", onclick: toggle, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } } },
      h("td", {}, h("span", { class: "caret", "aria-hidden": "true" }, "▸"), t.label),
      h("td", {}, h("span", { class: `target ${t.target}` }, TARGETS[t.target])),
      h("td", { class: "num" }, `${t.con} of ${t.n} (${pc(t.share)})`),
      h("td", {}, t.pro ? `${t.con} ${t.conLabel}, ${t.pro} ${t.proLabel} (D ${f2(t.D)})` : `${t.conLabel} only (D ${f2(t.D)})`),
      h("td", { title: t.corr.why }, t.corr.ok ? "Yes" : "No"),
      h("td", { class: "num" }, t.R),
      h("td", { class: "num" }, t.scored ? [h("span", { class: `bar${t.signal ? "" : " zero"}`, style: `width:${Math.round((t.signal / max) * 4 * 16)}px` }), (t.signal * 100).toFixed(1)] : "not scored")));
    if (isOpen) {
      rows.push(h("tr", { class: "examples" }, h("td", { colspan: 7 },
        h("p", { class: "why" }, `Numeric check: ${t.corr.why}.`),
        t.con ? [h("h4", {}, `${t.conLabel[0].toUpperCase()}${t.conLabel.slice(1)} (${t.con})`), h("ul", {}, t.examples.con.map((e) => highlight(e, SHORT_Q[e.column])))] : null,
        t.pro ? [h("h4", {}, `${t.proLabel[0].toUpperCase()}${t.proLabel.slice(1)} (${t.pro})`), h("ul", {}, t.examples.pro.map((e) => highlight(e, SHORT_Q[e.column])))] : null)));
    }
  }
  return h("div", { class: "panel" },
    h("h3", {}, "Comment themes"),
    h("p", { class: "explain" }, "Sorted by signal. Click a theme to see the comments behind it and check the coding. Themes outside your control are listed but never scored."),
    rows.length
      ? h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
        h("thead", {}, h("tr", {}, h("th", {}, "Theme"), h("th", {}, "About"), h("th", { class: "num" }, "Raised by"), h("th", {}, "Direction"), h("th", {}, "Backed by a number"), h("th", { class: "num" }, "R"), h("th", { class: "num" }, "Signal"))),
        h("tbody", {}, rows)))
      : h("p", {}, "No themes found in the written responses."),
  );
}

function acrossCourses(analyzed) {
  const ids = analyzed[0].themes.map((t) => t.id);
  const byId = (a, id) => a.themes.find((t) => t.id === id);
  const rows = ids
    .map((id) => ({ id, t: byId(analyzed[0], id), total: analyzed.reduce((s, a) => s + byId(a, id).signal, 0) }))
    .filter((r) => analyzed.some((a) => byId(a, r.id).con))
    .sort((x, y) => y.t.R - x.t.R || y.total - x.total);
  return h("article", { class: "course-card summary-card" },
    h("h2", {}, "Across your courses"),
    h("p", { class: "explain" }, "A theme that shows up in several courses, with different students, is the strongest evidence that it is about how you teach rather than one cohort."),
    h("div", { class: "tbl-wrap" }, h("table", { class: "tbl" },
      h("thead", {}, h("tr", {}, h("th", {}, "Theme"), h("th", {}, "About"), ...analyzed.map((a) => h("th", { class: "num" }, `${a.course} ${a.term || ""}`)), h("th", { class: "num" }, "Courses"))),
      h("tbody", {}, rows.map((r) => h("tr", {},
        h("td", {}, r.t.label),
        h("td", {}, h("span", { class: `target ${r.t.target}` }, TARGETS[r.t.target])),
        ...analyzed.map((a) => { const t = byId(a, r.id); return h("td", { class: "num" }, t.n ? pc(t.share) : "–"); }),
        h("td", { class: "num" }, r.t.R)))))));
}

// ---------- export ----------

function downloadJSON() {
  const data = (state.last || []).map((a) => ({
    course: a.course, section: (a.section || a.open || {}).section, term: a.term, credits: a.credits,
    responseRate: a.responseRate, deptAvgResponse: a.deptAvgResponse,
    groups: a.groups.map(({ key, label, mean, dept, gap, lambda, adjGap }) => ({ key, label, mean, dept, gap, lambda, adjGap })),
    items: Object.values(a.stats).map(({ item, label, n, mean, sd, dept, gap, lambda, adjGap, lowShare }) => ({ item, label, n, mean, sd, deptMean: dept && dept.mean, gap, lambda, adjGap, lowShare })),
    baseline: a.baseline,
    // Counts and scores only: no comment text leaves in the export.
    themes: a.themes.map(({ id, label, target, con, pro, n, share, D, C, R, signal, corr }) => ({ id, label, target, con, pro, n, share, D, C, R, signal, corroboration: corr.why })),
  }));
  const blob = new Blob([JSON.stringify({ tool: "SRTI Analyzer", version: "0.1", assumptions: state.opts, courses: data }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  h("a", { href: url, download: "srti-analysis.json" }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

renderSettings();
wireLoad();
render();
