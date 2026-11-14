// SRTI Analyzer: the method. Pure functions over parsed reports (see parse.js).
//
// What it computes, per course:
//   1. Reliability-weighted gaps from the department mean, per item.
//   2. The grade baseline: how many low course ratings the expected-grade mix
//      predicts, against how many there were (Tim's original test).
//   3. Comment themes, each with a target, a direction, corroboration by a
//      numeric item, and recurrence across the loaded courses, combined into
//      one signal: (shrunk share - baseline) x D x C x R.
// The keyword coding here is a first pass. Every theme lists the comments it
// matched so a person can check it; Claude coding replaces it in a later step.

export const DEFAULTS = {
  tau: 0.3, // between-section SD of a true item mean (assumed until department data)
  pLow: 0.4, // chance a low-grade student rates the course 1 or 2 (assumed)
  pHigh: 0.03, // chance any other student does (assumed)
  k0: 10, // pseudo-count shrinking a theme share toward the baseline
  themeBase: 0.05, // share of respondents expected to raise any one theme (assumed)
  credits: 3,
  recurMin: 0.05, // a theme "recurs" in a course when at least this share raises it
};

export const ITEM_GROUPS = [
  { key: "teaching", label: "Teaching", items: [1, 2, 3, 4, 5, 6, 9, 10] },
  { key: "assessment", label: "Assessment and feedback", items: [7, 8] },
  { key: "course", label: "Course overall", items: [11, 12] },
];

const LOW_GRADES = ["C+", "C", "C-", "D+", "D", "D-", "F"];
const LETTERS = ["A", "A-", "B+", "B", "B-", ...LOW_GRADES];

// ---------- numeric items ----------

export function itemStats(section, opts = DEFAULTS) {
  const N = section.enrolled || 0;
  const out = {};
  for (const [k, it] of Object.entries(section.items)) {
    if (it.mean == null) continue;
    const n = it.n || 0;
    const fpc = N > 1 && n < N ? Math.sqrt((N - n) / (N - 1)) : n >= N && N > 0 ? 0.0001 : 1;
    const se = n > 0 && it.sd != null ? (it.sd / Math.sqrt(n)) * fpc : Infinity;
    const lambda = (opts.tau * opts.tau) / (opts.tau * opts.tau + se * se);
    const gap = it.dept ? it.mean - it.dept.mean : null;
    out[k] = { ...it, se, lambda, gap, adjGap: gap == null ? null : lambda * gap, lowShare: it.dist ? (it.dist[3] || 0) + (it.dist[4] || 0) : null };
  }
  return out;
}

export function groupStats(stats) {
  return ITEM_GROUPS.map((g) => {
    const rows = g.items.map((i) => stats[i]).filter((s) => s && s.adjGap != null);
    const avg = (f) => (rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : null);
    return { ...g, n: rows.length, mean: avg((r) => r.mean), dept: avg((r) => r.dept.mean), gap: avg((r) => r.gap), adjGap: avg((r) => r.adjGap), lambda: avg((r) => r.lambda) };
  });
}

// ---------- grade baseline ----------

export function gradeBaseline(section, stats, opts = DEFAULTS) {
  const dist = (section.characteristics && section.characteristics.expectedGrade) || [];
  const share = (label) => (dist.find((d) => d.label === label) || {}).share || 0;
  const letterTotal = LETTERS.reduce((a, l) => a + share(l), 0);
  const other = share("Other");
  const out = { letterTotal, other, aShare: share("A") + share("A-") };
  if (!dist.length) return { ...out, status: "missing" };
  if (other > 0.5 || letterTotal < 0.25) return { ...out, status: "passfail" };
  const r = LOW_GRADES.reduce((a, l) => a + share(l), 0) / letterTotal;
  const course = stats[12];
  if (!course || course.lowShare == null) return { ...out, r, status: "no-rating" };
  const n = course.n;
  const expected = r * opts.pLow + (1 - r) * opts.pHigh;
  const observed = course.lowShare;
  const z = (observed - expected) / Math.sqrt((expected * (1 - expected)) / n);
  const respondents = section.responded || n;
  return {
    ...out,
    status: "ok",
    r,
    lowGradeCount: r * letterTotal * respondents,
    lowRatingCount: observed * n,
    expected,
    observed,
    z,
    n,
  };
}

// ---------- workload corroboration ----------

const HOURS = [
  { re: /^Less than 1/, lo: 0 },
  { re: /^1-2/, lo: 1 },
  { re: /^2-4/, lo: 2 },
  { re: /^4-6/, lo: 4 },
  { re: /^6-8/, lo: 6 },
  { re: /^8-10/, lo: 8 },
  { re: /^More than 10/, lo: 10 },
];

// Share of respondents working more than about two hours per credit per week
// outside class: the bins whose lower edge is above 2 x credits.
export function overloadShare(section, credits) {
  const dist = (section.characteristics && section.characteristics.hours) || [];
  let s = 0;
  for (const d of dist) {
    const bin = HOURS.find((h) => h.re.test(d.label));
    if (bin && bin.lo > 2 * credits) s += d.share || 0;
  }
  return dist.length ? s : null;
}

// ---------- themes ----------

const below = (stats, item) => stats[item] && stats[item].dept && stats[item].mean < stats[item].dept.mean;
const lowestDiagnostic = (stats, item) => {
  const diag = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => stats[i]).filter((s) => s && s.mean != null);
  return diag.length && stats[item] && stats[item].mean === Math.min(...diag.map((s) => s.mean));
};

// con: the complaint. pro: the opposite statement (praise, or the other
// direction). D = |con - pro| / (con + pro). Targets: instructor, design
// (course design the instructor controls), format, staff, outside (not the
// instructor's to fix; shown, never scored).
export const THEMES = [
  {
    id: "workload",
    label: "Workload",
    target: "design",
    conLabel: "too much",
    proLabel: "about right",
    exclusive: true,
    con: [/\b(too much|ridiculous|overwhelm\w*|way longer|more (hours|work) than|more time on this course)\b/i, /\b(one|1)[- ]credit\b.{0,80}\b(work|difficult|time|hours|challeng)/i, /\b(work|workload|projects).{0,60}\b(one|1)[- ]credit\b/i, /\bmore credits\b|\b(2|two|3|three)(-3)? credits\b|\bextra credit or\b/i, /\bcredit (allocation|hours?)\b/i, /\b(lot of|amount of) work\b/i, /\bfewer projects\b/i],
    pro: [/\b(workload|work load|amount of work)\b.{0,40}\b(manageable|reasonable|fine|right)\b/i, /\bright amount of work\b/i, /\bworkload for the course is (also )?reasonable\b/i],
    corroborate: (stats, section, course) => {
      const s = overloadShare(section, course.credits);
      return s == null ? { ok: false, why: "no hours item" } : { ok: s >= 0.33, why: `${Math.round(s * 100)}% report more than ${2 * course.credits} hours a week outside class (${course.credits} credits)` };
    },
  },
  {
    id: "feedback",
    label: "Feedback on graded work",
    target: "design",
    negate: false, // "never got feedback" is the complaint itself
    conLabel: "not enough",
    proLabel: "helpful",
    con: [/\bfeedback\b(?!.{0,20}(was|is|were) (great|helpful|good))/i, /\b(the|getting|giving|having|receive what the) (the )?correct (answers?|solutions?|answer should be)\b/i, /\b(what|which questions) I (got|did|was doing) wrong\b/i, /\bwhy (that|an?|my|the)? ?(certain )?answer was wrong\b/i, /\breview of my performance\b/i, /\bwalk-?through solution\b/i, /\banswers aren'?t clear\b/i],
    pro: [/\bfeedback (was|is|were) (great|helpful|good|useful)\b/i],
    corroborate: (stats) => {
      if (!stats[7]) return { ok: false, why: "no feedback item" };
      const ok = below(stats, 7) || lowestDiagnostic(stats, 7);
      return { ok, why: `feedback item ${stats[7].mean.toFixed(1)} vs department ${stats[7].dept ? stats[7].dept.mean.toFixed(1) : "n/a"}${lowestDiagnostic(stats, 7) ? ", lowest diagnostic item" : ""}` };
    },
  },
  {
    id: "difficulty",
    label: "Difficulty of assessments",
    target: "design",
    conLabel: "too hard",
    proLabel: "too easy",
    con: [/\b(too|very|quite|needlessly|unnecessarily|insanely|excessively|way too|extremely) (hard|difficult|challenging)\b/i, /\b(were|was|is|are) (hard|HARD)\b/i, /\bvirtually impossible\b/i, /\b(too|felt|bit) rushed\b/i, /\b(more time (to work|on the quiz|for the quiz)|slightly easier|less questions|fewer questions)\b/i, /\btrick questions\b/i, /\bhard to keep up\b/i, /\bover my head\b/i, /\bfelt unprepared\b/i, /\bpractice (quiz|quizzes|exam|problems)\b/i, /\bmock quiz\b/i],
    pro: [/\bmore (rigorous|challenging|intensive|depth|content)\b/i, /\b(should|could) be more difficult\b/i, /\b(harder and|be (more )?harder|harder projects|projects .{0,30}harder)\b/i, /\bnot (go )?deep enough\b/i, /\boversimplified\b/i, /\btoo easy\b/i, /\bshould be more difficult\b/i],
    corroborate: (stats) => {
      if (!stats[8]) return { ok: false, why: "no fairness item" };
      return { ok: below(stats, 8), why: `"methods of evaluating my work were fair" ${stats[8].mean.toFixed(1)} vs department ${stats[8].dept ? stats[8].dept.mean.toFixed(1) : "n/a"}` };
    },
  },
  {
    id: "clarity",
    label: "Clarity of explanations",
    target: "instructor",
    conLabel: "unclear",
    proLabel: "clear",
    con: [/\b(unclear|confusing|confused|not clear|clearer|misleading|hard to (understand|follow)|lost (me|on)|left open for interpretation|got lost|felt a little bit lost|sparse)\b/i],
    pro: [/\b(explains?|explained|explanations?)\b.{0,30}\b(clear|clearly|well)\b/i, /\bclear (explanations|and concise)\b/i, /\beasy to (understand|follow)\b/i],
    corroborate: (stats) => {
      if (!stats[2]) return { ok: false, why: "no clarity item" };
      return { ok: below(stats, 2) || below(stats, 3), why: `"explained material clearly" ${stats[2].mean.toFixed(1)} vs department ${stats[2].dept ? stats[2].dept.mean.toFixed(1) : "n/a"}` };
    },
  },
  {
    id: "engagement",
    label: "Engagement in class",
    target: "instructor",
    conLabel: "dull",
    proLabel: "engaging",
    con: [/\b(boring|monotonous|dull|drag on|tedious)\b(?! (topic|segments))/i, /\bhard (for me )?to focus\b/i, /\b(be|been) more (engaging|interactive)\b/i, /\bmore interactive components\b/i, /\bmore active student involvement\b/i],
    pro: [/(?<!more )\b(engaging|enthusias\w*|passion\w*|entertaining|energ\w*|funny|humou?r)\b/i, /\bnever boring\b/i],
    corroborate: (stats) => {
      if (!stats[5]) return { ok: false, why: "no interest item" };
      return { ok: below(stats, 5), why: `"inspired interest" ${stats[5].mean.toFixed(1)} vs department ${stats[5].dept ? stats[5].dept.mean.toFixed(1) : "n/a"}` };
    },
  },
  {
    id: "materials",
    label: "Assignment materials and organization",
    target: "design",
    conLabel: "unclear or disorganized",
    proLabel: "well organized",
    con: [/\b(documentation|instructions|write ?ups?|typos|descriptions?)\b.{0,50}\b(unclear|clearer|insufficient|confusing|vague|updated|organized|difficult|more|better|precise|misleading)\b/i, /\b(better|clearer|more) (project )?(documentation|instructions)\b/i, /\btypos\b/i, /\bmore organi[sz]ation\b/i, /\bchanging all the time\b/i, /\bwere no longer applicable\b/i],
    pro: [/\b(well[- ]organized|very organized|well structured|well-structured|organized and)\b/i, /\bgood documentation\b/i],
    corroborate: (stats, section) => {
      const e = (section.extras || []).find((x) => /expectations/.test(x.label));
      return e ? { ok: e.mean < 4, why: `"understood the expectations" ${e.mean.toFixed(1)} (no department mean)` } : { ok: false, why: "no expectations item" };
    },
  },
  {
    id: "format",
    label: "Course format",
    target: "format",
    conLabel: "wants a different format",
    proLabel: "likes the format",
    con: [/\b(in[- ]person (section|class|lectures?)?|live zoom|physical class)\b.{0,40}\b(would|prefer|rather|better|help)/i, /\b(prefer|rather|would like|have)\b.{0,40}\b(in[- ]person|live zoom|physical class)\b/i, /\bstruggle with online\b/i, /\bif it was in person\b/i, /\b(locked|unlock\w*|opening all modules)\b.{0,40}\b(unfair|instead|behind|late)\b/i],
    pro: [/\b(self[- ]paced|own pace|online format|flexib\w+|async\w*|recorded|remote)\b.{0,40}\b(nice|good|great|helpful|like|love|enjoy|convenient)\b/i, /\b(like|love|enjoy\w*|appreciat\w*|convenient)\b.{0,40}\b(self[- ]paced|own pace|online|flexib\w+|async\w*|remote)\b/i],
    corroborate: () => ({ ok: false, why: "no matching item" }),
  },
  {
    id: "staff",
    label: "Course staff (TAs, UCAs)",
    target: "staff",
    conLabel: "unhelpful or inconsistent",
    proLabel: "helpful",
    con: [/\b(TA'?s|TAs|UCAs?|teaching assistants?)\b.{0,60}\b(hostile|more helpful|more skilled|consistent\w*|act together|more understanding|unhelpful|availability)\b/i, /\b(more skilled|better) TA/i, /\bTA availability\b/i],
    pro: [/\b(TA'?s|TAs|UCAs?)\b.{0,40}\b(helpful|great|amazing|awesome|supportive|responsive|goated)\b/i],
    corroborate: (stats, section) => {
      const e = (section.extras || []).find((x) => /supports available/.test(x.label));
      return e ? { ok: e.mean < 4, why: `"supports available helped me learn" ${e.mean.toFixed(1)} (no department mean)` } : { ok: false, why: "no supports item" };
    },
  },
  {
    id: "room",
    label: "Room and building",
    target: "outside",
    conLabel: "complaint",
    proLabel: "",
    con: [/\b(classroom|lecture halls?|goessman|power outlets?|lighting|different room)\b/i],
    pro: [],
    corroborate: (stats, section) => {
      const it = section.items && section.items[17];
      if (!it || !it.dist) return { ok: false, why: "no room item" };
      const dis = (it.dist[2] || 0) + (it.dist[3] || 0);
      return { ok: dis > 0.25, why: `${Math.round(dis * 100)}% disagree the room was conducive to learning` };
    },
  },
  {
    id: "time",
    label: "Time slot",
    target: "outside",
    conLabel: "complaint",
    proLabel: "",
    con: [/\b(10 ?ams?|morning class(es)?|later in the day|not at \d+|half asleep)\b/i],
    pro: [],
    corroborate: () => ({ ok: false, why: "no matching item" }),
  },
  {
    id: "infrastructure",
    label: "Campus computing (Edlab and similar)",
    target: "outside",
    conLabel: "complaint",
    proLabel: "",
    con: [/\bedlab\b/i, /\bed lab\b/i],
    pro: [],
    corroborate: () => ({ ok: false, why: "no matching item" }),
  },
];

export const TARGETS = {
  instructor: "Instructor",
  design: "Course design",
  format: "Format",
  staff: "Course staff",
  outside: "Outside the instructor's control",
};

// A complaint just after "not", "never", "no" or "n't" is not a complaint
// ("things don't get too difficult", "never boring").
const NEGATED = /\b(not|never|no|n't|didn't|don't|doesn't|isn't|wasn't)\b[^.!?]{0,18}$/i;

function matches(res, cells, { negate = false, unless = null } = {}) {
  for (let c = 0; c < cells.length; c++) {
    if (unless && unless.some((re) => re.test(cells[c]))) continue;
    for (const re of res) {
      const m = re.exec(cells[c]);
      if (!m) continue;
      if (negate && NEGATED.test(cells[c].slice(0, m.index))) continue;
      return { column: c, text: cells[c], index: m.index, length: m[0].length };
    }
  }
  return null;
}

export function codeComments(open) {
  const respondents = open.responses.filter((r) => r.substantive);
  return THEMES.map((t) => {
    const con = [];
    const pro = [];
    for (const r of respondents) {
      const a = matches(t.con, r.cells, { negate: t.negate !== false, unless: t.exclusive ? t.pro : null });
      const b = t.pro.length ? matches(t.pro, r.cells) : null;
      if (a) con.push(a);
      if (b) pro.push(b);
    }
    return { id: t.id, con, pro, n: respondents.length };
  });
}

// ---------- one course ----------

export function analyzeCourse(course, opts = DEFAULTS) {
  const out = { ...course, warnings: [] };
  if (!course.section) out.warnings.push("Section Report missing: numeric items, baseline and corroboration are unavailable.");
  if (!course.open) out.warnings.push("Open-Ended Responses missing: no comment themes.");
  const section = course.section || { items: {}, characteristics: {}, extras: [] };
  const stats = itemStats(section, opts);
  out.stats = stats;
  out.groups = groupStats(stats);
  out.baseline = gradeBaseline(section, stats, opts);
  out.responseRate = section.enrolled ? section.responded / section.enrolled : null;
  out.deptAvgResponse = section.comparison && section.comparison.dept ? section.comparison.dept.avgResponse : null;
  out.coded = course.open ? codeComments(course.open) : [];
  out.respondentsWithText = course.open ? course.open.responses.filter((r) => r.substantive).length : 0;
  out.corroboration = {};
  for (const t of THEMES) out.corroboration[t.id] = course.section ? t.corroborate(stats, section, course) : { ok: false, why: "no Section Report" };
  return out;
}

// ---------- across courses ----------

export function scoreThemes(analyzed, opts = DEFAULTS) {
  // Recurrence: in how many loaded courses does each theme reach recurMin?
  const recur = {};
  for (const t of THEMES) {
    recur[t.id] = analyzed.filter((a) => {
      const c = a.coded.find((x) => x.id === t.id);
      return c && c.n > 0 && c.con.length / c.n >= opts.recurMin;
    }).length;
  }
  for (const a of analyzed) {
    a.themes = THEMES.map((t) => {
      const c = a.coded.find((x) => x.id === t.id) || { con: [], pro: [], n: 0 };
      const n = c.n;
      const con = c.con.length;
      const pro = c.pro.length;
      const share = n ? con / n : 0;
      const shrunk = (con + opts.k0 * opts.themeBase) / (n + opts.k0);
      const excess = Math.max(0, shrunk - opts.themeBase);
      const D = con + pro ? Math.abs(con - pro) / (con + pro) : 0;
      const dominant = con >= pro ? t.conLabel : t.proLabel;
      const corr = a.corroboration[t.id] || { ok: false, why: "" };
      const C = corr.ok ? 1 : 0.5;
      const R = Math.max(1, recur[t.id]);
      const scored = t.target !== "outside";
      // Signal counts only the complaint side: if the opposite side wins, the
      // theme says the course is fine on this dimension.
      const signal = scored && con > pro ? excess * D * C * R : 0;
      return { ...t, con, pro, n, share, shrunk, excess, D, dominant, corr, C, R, signal, scored, examples: c };
    }).sort((x, y) => y.signal - x.signal || y.share - x.share);
  }
  return analyzed;
}

export function analyzeAll(courses, opts = DEFAULTS) {
  return scoreThemes(courses.map((c) => analyzeCourse(c, opts)), opts);
}
