// The four activity kinds: their settings, the student form, results charts and CSV columns.
// Response bodies (written only by submit_response in schema.sql):
//   card  {text, tag}        poll  {choice}        scale {value}        sort {placements: [bucket|null, ...]}

import { esc } from "./common.js";

const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

export const KINDS = {
  card: {
    label: "Cards (free text)",
    defaults: { tags: [], tag_required: false, max_len: 280, per_device: 5, group: "optional" },
    editor: (c) => `
      <label>Tags, one per line (optional)<textarea name="tags" rows="3" placeholder="Box 2&#10;Box 3&#10;Box 4">${esc((c.tags || []).join("\n"))}</textarea></label>
      <label class="check"><input type="checkbox" name="tag_required" ${c.tag_required ? "checked" : ""}> Tag required</label>
      <div class="row">
        <label>Max characters<input type="number" name="max_len" min="20" max="2000" value="${c.max_len ?? 280}"></label>
        <label>Cards per person<input type="number" name="per_device" min="1" max="50" value="${c.per_device ?? 5}"></label>
      </div>`,
    read: (f) => ({
      tags: lines(f.tags.value).slice(0, 12).map((t) => t.slice(0, 40)),
      tag_required: f.tag_required.checked,
      max_len: clamp(+f.max_len.value || 280, 20, 2000),
      per_device: clamp(+f.per_device.value || 5, 1, 50),
    }),
    check: (c) => (c.tag_required && !c.tags.length ? "Tag required needs at least one tag." : null),
  },

  poll: {
    label: "Poll",
    defaults: { options: [], group: "optional" },
    editor: (c) => `
      <label>Options, one per line (2 to 10)<textarea name="options" rows="4">${esc((c.options || []).join("\n"))}</textarea></label>`,
    read: (f) => ({ options: lines(f.options.value).map((t) => t.slice(0, 120)) }),
    check: (c) => (c.options.length < 2 || c.options.length > 10 ? "A poll needs 2 to 10 options." : null),
  },

  sort: {
    label: "Sort into buckets",
    defaults: { items: [], buckets: ["Fixed", "Growth", "Not clear"], group: "optional" },
    editor: (c) => `
      <label>Items to sort, one per line (1 to 20)<textarea name="items" rows="5">${esc((c.items || []).join("\n"))}</textarea></label>
      <label>Buckets, one per line (2 or 3)<textarea name="buckets" rows="3">${esc((c.buckets || []).join("\n"))}</textarea></label>`,
    read: (f) => ({
      items: lines(f.items.value).map((t) => t.slice(0, 200)),
      buckets: lines(f.buckets.value).map((t) => t.slice(0, 30)),
    }),
    check: (c) =>
      c.items.length < 1 || c.items.length > 20 ? "Sort needs 1 to 20 items."
        : c.buckets.length < 2 || c.buckets.length > 3 ? "Sort needs 2 or 3 buckets." : null,
  },

  scale: {
    label: "Scale 1 to 5",
    defaults: { low: "", high: "", group: "optional" },
    editor: (c) => `
      <div class="row">
        <label>Label for 1<input name="low" maxlength="40" value="${esc(c.low)}" placeholder="Not at all"></label>
        <label>Label for 5<input name="high" maxlength="40" value="${esc(c.high)}" placeholder="Very much"></label>
      </div>`,
    read: (f) => ({ low: f.low.value.trim(), high: f.high.value.trim() }),
    check: () => null,
  },

  vote: {
    label: "Vote, discuss, vote again",
    defaults: { options: [], confidence: true, round: 1, group: "optional" },
    editor: (c) => `
      <label>Options, one per line (2 to 10)<textarea name="options" rows="4">${esc((c.options || []).join("\n"))}</textarea></label>
      <label class="check"><input type="checkbox" name="confidence" ${c.confidence !== false ? "checked" : ""}> Ask how sure they are</label>
      <p class="muted small">Round 1 opens with the activity. After the discussion, press "Start round 2" on the Results or Projector page.</p>`,
    read: (f) => ({ options: lines(f.options.value).slice(0, 10).map((t) => t.slice(0, 120)), confidence: f.confidence.checked, round: 1 }),
    check: (c) => (c.options.length < 2 ? "A vote needs 2 to 10 options." : null),
  },

  dots: {
    label: "Dot voting on posted cards",
    defaults: { source: "", votes: 3, group: "optional" },
    editor: (c) => `
      <label>Code of the Cards activity to vote on (in this space)<input name="source" maxlength="12" autocapitalize="none" value="${esc(c.source)}" placeholder="ec7u"></label>
      <label>Votes per person (1 to 10)<input type="number" name="votes" min="1" max="10" value="${c.votes ?? 3}"></label>
      <p class="muted small">While this is open, students see that activity's cards (not hidden ones, never group names) and vote for the ones they like.</p>`,
    read: (f) => ({ source: f.source.value.trim().toLowerCase(), votes: clamp(+f.votes.value || 3, 1, 10) }),
    check: (c) => (!/^[a-z0-9]{4,12}$/.test(c.source) ? "Enter the code of a Cards activity in this space." : null),
  },

  slider: {
    label: "Where do you stand? (slider)",
    defaults: { low: "", high: "", group: "optional" },
    editor: (c) => `
      <div class="row">
        <label>Left end<input name="low" maxlength="60" value="${esc(c.low)}" placeholder="Never give hints"></label>
        <label>Right end<input name="high" maxlength="60" value="${esc(c.high)}" placeholder="Always give hints"></label>
      </div>`,
    read: (f) => ({ low: f.low.value.trim(), high: f.high.value.trim() }),
    check: (c) => (!c.low || !c.high ? "Name both ends of the slider." : null),
  },

  qa: {
    label: "Question queue (upvotes)",
    defaults: { max_len: 280, per_device: 3, group: "off" },
    editor: (c) => `
      <div class="row">
        <label>Max characters<input type="number" name="max_len" min="20" max="1000" value="${c.max_len ?? 280}"></label>
        <label>Questions per person<input type="number" name="per_device" min="1" max="20" value="${c.per_device ?? 3}"></label>
      </div>
      <p class="muted small">Students see every question (never names) and can upvote each one once. Hide a question to take it off the list.</p>`,
    read: (f) => ({ max_len: clamp(+f.max_len.value || 280, 20, 1000), per_device: clamp(+f.per_device.value || 3, 1, 20) }),
    check: () => null,
  },

  rank: {
    label: "Rank these",
    defaults: { items: [], group: "optional" },
    editor: (c) => `
      <label>Items to rank, one per line (2 to 10)<textarea name="items" rows="5">${esc((c.items || []).join("\n"))}</textarea></label>`,
    read: (f) => ({ items: lines(f.items.value).slice(0, 10).map((t) => t.slice(0, 120)) }),
    check: (c) => (c.items.length < 2 ? "Ranking needs 2 to 10 items." : null),
  },

  quiz: {
    label: "Check your answer",
    defaults: { answers: [], numeric: false, tolerance: 0, reveal: true, group: "optional" },
    editor: (c) => `
      <label>Accepted answers, one per line<textarea name="answers" rows="3">${esc((c.answers || []).join("\n"))}</textarea></label>
      <label class="check"><input type="checkbox" name="numeric" ${c.numeric ? "checked" : ""}> The answer is a number</label>
      <label>Allowed difference for a number<input type="number" name="tolerance" step="any" min="0" value="${c.tolerance ?? 0}"></label>
      <label class="check"><input type="checkbox" name="reveal" ${c.reveal !== false ? "checked" : ""}> Tell each student right away whether they are right</label>
      <p class="muted small">Accepted answers never reach students. Text answers ignore capitals and extra spaces.</p>`,
    read: (f) => ({
      answers: lines(f.answers.value).slice(0, 20).map((t) => t.slice(0, 200)),
      numeric: f.numeric.checked, tolerance: Math.max(0, +f.tolerance.value || 0), reveal: f.reveal.checked,
    }),
    check: (c) => (!c.answers.length ? "Give at least one accepted answer."
      : c.numeric && c.answers.some((x) => !isFinite(+x.replace(/,/g, ""))) ? "Number answers must be numbers." : null),
  },

  hotspot: {
    label: "Click on the picture",
    defaults: { image_url: "", points: 1, group: "optional" },
    editor: (c) => `
      <label>Image address (https)<input name="image_url" type="url" maxlength="500" value="${esc(c.image_url)}" placeholder="https://…"></label>
      <label>Taps per person (1 to 5)<input type="number" name="points" min="1" max="5" value="${c.points ?? 1}"></label>
      <p class="muted small">Use an image anyone can open without signing in, for example one in the site's repo.</p>`,
    read: (f) => ({ image_url: f.image_url.value.trim(), points: clamp(+f.points.value || 1, 1, 5) }),
    check: (c) => (!/^https:\/\/\S+$/.test(c.image_url) ? "Give an https address for the image." : null),
  },

  ticket: {
    label: "Two-part exit ticket",
    defaults: { low: "", high: "", question: "", max_len: 400, group: "off" },
    editor: (c) => `
      <div class="row">
        <label>Label for 1<input name="low" maxlength="40" value="${esc(c.low)}" placeholder="Lost"></label>
        <label>Label for 5<input name="high" maxlength="40" value="${esc(c.high)}" placeholder="Got it"></label>
      </div>
      <label>Question for the written part<input name="question" maxlength="200" value="${esc(c.question)}" placeholder="One thing that did not land"></label>
      <label>Max characters<input type="number" name="max_len" min="20" max="2000" value="${c.max_len ?? 400}"></label>`,
    read: (f) => ({ low: f.low.value.trim(), high: f.high.value.trim(), question: f.question.value.trim(), max_len: clamp(+f.max_len.value || 400, 20, 2000) }),
    check: (c) => (!c.question ? "Write the question for the written part." : null),
  },
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

// ---------------------------------------------------------------- results

// Charts take only visible responses. `big` is the projector size.
// `names` puts each card's group label on it (the projector's Names toggle; off by default).
// `extra.cards` is the dot-voting source: [{id, text, tag}] of visible cards.
export function renderResults(act, responses, { big = false, names = false, extra = {} } = {}) {
  const shown = responses.filter((r) => !r.hidden);
  const c = act.config || {};
  if (act.kind === "card") return renderCards(c, shown, big, names);
  if (act.kind === "poll") return renderPoll(c, shown);
  if (act.kind === "scale") return renderScale(c, shown);
  if (act.kind === "sort") return renderSort(c, shown);
  if (act.kind === "vote") return renderVote(c, shown);
  if (act.kind === "dots") return renderDots(c, shown, extra.cards || []);
  if (act.kind === "slider") return renderSlider(c, shown);
  if (act.kind === "qa") return renderQa(shown);
  if (act.kind === "rank") return renderRank(c, shown);
  if (act.kind === "quiz") return renderQuiz(c, shown);
  if (act.kind === "hotspot") return renderHotspot(c, shown);
  if (act.kind === "ticket") return renderTicket(c, shown, big);
  return "";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Round 1 against round 2, with how many devices that answered both changed their answer.
function renderVote(c, rows) {
  const opts = c.options || [];
  const rounds = [1, 2].map((k) => rows.filter((r) => (r.body.round || 1) === k));
  const counts = rounds.map((rs) => opts.map((_, i) => rs.filter((r) => r.body.choice === i).length));
  const max = Math.max(1, ...counts.flat());
  const sure = (rs) => mean(rs.filter((r) => r.body.confidence).map((r) => r.body.confidence));
  const first = new Map(rounds[0].filter((r) => r.device).map((r) => [r.device, r.body.choice]));
  const both = rounds[1].filter((r) => r.device && first.has(r.device));
  const changed = both.filter((r) => first.get(r.device) !== r.body.choice).length;
  const sureText = (rs) => (sure(rs) === null ? "" : `, average sureness ${sure(rs).toFixed(1)} of 3`);
  return `<p class="n">Now voting: round ${c.round === 2 ? 2 : 1}</p>
    <p class="muted">Round 1: ${plural(rounds[0].length, "vote")}${sureText(rounds[0])}.
      Round 2: ${plural(rounds[1].length, "vote")}${sureText(rounds[1])}.
      ${both.length ? `${changed} of ${both.length} who voted twice changed their answer.` : ""}</p>
    <div class="legend"><span><i class="sw s1"></i>Round 1</span><span><i class="sw s2"></i>Round 2</span></div>
    <div class="bars">${opts.map((o, i) => `
      <div class="bar-row">
        <div class="bar-label">${esc(o)}</div>
        <div class="vote-tracks">${[0, 1].map((k) => `
          <div class="bar-track thin"><div class="bar s${k + 1}" style="width:${(100 * counts[k][i]) / max}%"></div></div>`).join("")}
        </div>
        <div class="bar-val">${counts[0][i]} → ${counts[1][i]}</div>
      </div>`).join("")}</div>`;
}

// Source cards, most votes first.
function renderDots(c, rows, cards) {
  const votes = new Map();
  rows.forEach((r) => (r.body.picks || []).forEach((id) => votes.set(id, (votes.get(id) || 0) + 1)));
  const list = cards.map((k) => ({ ...k, n: votes.get(k.id) || 0 })).sort((a, b) => b.n - a.n);
  const max = Math.max(1, ...list.map((k) => k.n));
  if (!cards.length) return `<p class="muted empty">No cards to vote on yet. Check the source code (${esc(c.source)}).</p>`;
  return `<p class="n">${plural(rows.length, "voter")} · ${plural(cards.length, "card")}</p>
    <div class="ranked">${list.map((k) => `
      <div class="ranked-row">
        <div class="ranked-n">${k.n}</div>
        <div class="ranked-body">
          <div class="bar-track thin"><div class="bar" style="width:${(100 * k.n) / max}%"></div></div>
          <div class="card-resp">${k.tag ? `<span class="muted">${esc(k.tag)} · </span>` : ""}${esc(k.text)}</div>
        </div>
      </div>`).join("")}</div>`;
}

// Every answer as a dot on the line, the average as a bar, and tens as a small histogram.
function renderSlider(c, rows) {
  const vals = rows.map((r) => r.body.value);
  const m = mean(vals);
  const bins = Array.from({ length: 10 }, (_, i) => vals.filter((v) => Math.min(9, Math.floor(v / 10)) === i).length);
  const max = Math.max(1, ...bins);
  return `<p class="n">${plural(rows.length, "answer")}${m === null ? "" : ` · average ${Math.round(m)} of 100`}</p>
    ${emptyNote(rows.length)}
    <div class="slider-res">
      <div class="slider-bins">${bins.map((n) => `<div class="sbin" title="${n}"><div class="sbin-bar" style="height:${(100 * n) / max}%"></div></div>`).join("")}</div>
      <div class="slider-line">${vals.map((v) => `<i class="sdot" style="left:${v}%"></i>`).join("")}${m === null ? "" : `<b class="smean" style="left:${m}%" title="average"></b>`}</div>
      <div class="hist-ends"><span>${esc(c.low)}</span><span>${esc(c.high)}</span></div>
    </div>`;
}

// Questions with their upvotes, most first.
function renderQa(rows) {
  const votes = new Map();
  rows.filter((r) => r.body.upvote).forEach((r) => votes.set(r.body.upvote, (votes.get(r.body.upvote) || 0) + 1));
  const qs = rows.filter((r) => r.body.text).map((r) => ({ r, n: votes.get(r.id) || 0 }))
    .sort((a, b) => b.n - a.n || String(a.r.created_at).localeCompare(String(b.r.created_at)));
  return `<p class="n">${plural(qs.length, "question")}</p>${emptyNote(qs.length)}
    <div class="ranked">${qs.map(({ r, n }) => `
      <div class="ranked-row"><div class="ranked-n">▲ ${n}</div>
        <div class="ranked-body"><div class="card-resp">${esc(r.body.text)}</div></div></div>`).join("")}</div>`;
}

// Average position (1 = top), best first, with how often each came first.
function renderRank(c, rows) {
  const items = c.items || [];
  const n = items.length;
  const stats = items.map((it, i) => {
    const pos = rows.map((r) => (r.body.order || []).indexOf(i)).filter((p) => p >= 0).map((p) => p + 1);
    return { i, avg: mean(pos), first: rows.filter((r) => (r.body.order || [])[0] === i).length };
  }).sort((a, b) => (a.avg ?? 99) - (b.avg ?? 99));
  return `<p class="n">${plural(rows.length, "ranking")}</p>${emptyNote(rows.length)}
    <div class="bars">${stats.map((s) => `
      <div class="bar-row" title="average position ${s.avg === null ? "-" : s.avg.toFixed(1)}">
        <div class="bar-label">${esc(items[s.i])}</div>
        <div class="bar-track"><div class="bar" style="width:${s.avg === null ? 0 : (100 * (n + 1 - s.avg)) / n}%"></div></div>
        <div class="bar-val">${s.avg === null ? "-" : `avg #${s.avg.toFixed(1)}`} <span class="muted">${pct(s.first, rows.length)}% first</span></div>
      </div>`).join("")}</div>`;
}

// Share right, then the most common answers, right or wrong.
function renderQuiz(c, rows) {
  const right = rows.filter((r) => r.body.correct).length;
  const groups = new Map();
  rows.forEach((r) => {
    const key = String(r.body.answer || "").toLowerCase().replace(/\s+/g, " ").trim();
    const g = groups.get(key) || { text: r.body.answer, n: 0, correct: !!r.body.correct };
    g.n++;
    groups.set(key, g);
  });
  const list = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 12);
  const max = Math.max(1, ...list.map((g) => g.n));
  return `<p class="n">${plural(rows.length, "answer")}${rows.length ? ` · ${pct(right, rows.length)}% right` : ""}</p>
    ${emptyNote(rows.length)}
    <div class="bars">${list.map((g) => `
      <div class="bar-row">
        <div class="bar-label"><span class="${g.correct ? "ok-mark" : "no-mark"}">${g.correct ? "Right" : "Wrong"}</span> ${esc(g.text)}</div>
        <div class="bar-track"><div class="bar ${g.correct ? "right" : "wrong"}" style="width:${(100 * g.n) / max}%"></div></div>
        <div class="bar-val">${g.n}</div>
      </div>`).join("")}</div>`;
}

// Every tap as a dot on the picture; overlapping dots read as hot spots.
function renderHotspot(c, rows) {
  const pts = rows.flatMap((r) => r.body.points || []);
  return `<p class="n">${plural(rows.length, "answer")} · ${plural(pts.length, "tap")}</p>
    <div class="hot-wrap"><img src="${esc(c.image_url)}" alt="The activity's picture">
      <div class="hot-layer">${pts.map((p) => `<i class="hot" style="left:${p.x * 100}%;top:${p.y * 100}%"></i>`).join("")}</div></div>`;
}

// The 1 to 5 chart, then every written answer with its number.
function renderTicket(c, rows, big) {
  const newest = [...rows].reverse();
  return `${renderScale(c, rows)}
    <h3 class="sub">${esc(c.question || "Written answers")}</h3>
    <div class="cards ${big ? "big" : ""}">${newest.map((r) => `
      <div class="card-resp"><span class="num-badge">${r.body.value}</span> ${esc(r.body.text)}</div>`).join("")}</div>`;
}

function emptyNote(n) {
  return n ? "" : `<p class="muted empty">No responses yet.</p>`;
}

function renderCards(c, rows, big, names = false) {
  const tags = c.tags || [];
  const card = (r) => `<div class="card-resp">${names && r.group_label ? `<div class="card-group">${esc(r.group_label)}</div>` : ""}${esc(r.body.text)}</div>`;
  const newest = [...rows].reverse();
  if (!tags.length) {
    return `<p class="n">${rows.length} card${rows.length === 1 ? "" : "s"}</p>
      ${emptyNote(rows.length)}<div class="cards ${big ? "big" : ""}">${newest.map(card).join("")}</div>`;
  }
  const groups = [...tags, null].map((t) => ({ t, rows: newest.filter((r) => (r.body.tag ?? null) === t) }))
    .filter((g) => g.t !== null || g.rows.length);
  return `<p class="n">${rows.length} card${rows.length === 1 ? "" : "s"}</p>${emptyNote(rows.length)}
    <div class="tag-cols" style="--cols:${groups.length}">
      ${groups.map((g) => `<section><h3>${esc(g.t ?? "No tag")} <span class="muted">${g.rows.length}</span></h3>
        <div class="cards ${big ? "big" : ""}">${g.rows.map(card).join("")}</div></section>`).join("")}
    </div>`;
}

function renderPoll(c, rows) {
  const opts = c.options || [];
  const counts = opts.map((_, i) => rows.filter((r) => r.body.choice === i).length);
  const max = Math.max(1, ...counts);
  return `<p class="n">${rows.length} answer${rows.length === 1 ? "" : "s"}</p>
    <div class="bars">${opts.map((o, i) => `
      <div class="bar-row" title="${esc(o)}: ${counts[i]} (${pct(counts[i], rows.length)}%)">
        <div class="bar-label">${esc(o)}</div>
        <div class="bar-track"><div class="bar" style="width:${(100 * counts[i]) / max}%"></div></div>
        <div class="bar-val">${counts[i]} <span class="muted">${pct(counts[i], rows.length)}%</span></div>
      </div>`).join("")}</div>`;
}

function renderScale(c, rows) {
  const counts = [1, 2, 3, 4, 5].map((v) => rows.filter((r) => r.body.value === v).length);
  const max = Math.max(1, ...counts);
  const mean = rows.length ? rows.reduce((s, r) => s + r.body.value, 0) / rows.length : null;
  return `<p class="n">${rows.length} answer${rows.length === 1 ? "" : "s"}${mean === null ? "" : ` · mean ${mean.toFixed(1)}`}</p>
    <div class="hist">${counts.map((n, i) => `
      <div class="hist-col" title="${i + 1}: ${n} (${pct(n, rows.length)}%)">
        <div class="hist-val">${n}</div>
        <div class="hist-track"><div class="hist-bar" style="height:${(100 * n) / max}%"></div></div>
        <div class="hist-label">${i + 1}</div>
      </div>`).join("")}</div>
    ${c.low || c.high ? `<div class="hist-ends"><span>1 = ${esc(c.low)}</span><span>5 = ${esc(c.high)}</span></div>` : ""}`;
}

function renderSort(c, rows) {
  const items = c.items || [];
  const buckets = c.buckets || [];
  const legend = `<div class="legend">${buckets.map((b, j) =>
    `<span><i class="sw s${j + 1}"></i>${esc(b)}</span>`).join("")}</div>`;
  return `<p class="n">${rows.length} sorter${rows.length === 1 ? "" : "s"}</p>${legend}
    <div class="stacks">${items.map((it, i) => {
      const counts = buckets.map((_, j) => rows.filter((r) => (r.body.placements || [])[i] === j).length);
      const total = counts.reduce((a, b) => a + b, 0);
      return `<div class="stack-row">
        <div class="stack-label">${esc(it)} <span class="muted">${total}</span></div>
        <div class="stack">${total ? counts.map((n, j) => n ? `
          <div class="seg s${j + 1}" style="flex:${n}" title="${esc(buckets[j])}: ${n} (${pct(n, total)}%)">
            <span>${pct(n, total) >= 12 ? `${pct(n, total)}%` : ""}</span></div>` : "").join("")
          : `<div class="seg none"></div>`}</div>
      </div>`;
    }).join("")}</div>`;
}

// ---------------------------------------------------------------- export

export function csvColumns(act) {
  const c = act.config || {};
  if (act.kind === "card") return [["tag", (b) => b.tag ?? ""], ["text", (b) => b.text]];
  if (act.kind === "poll") return [["choice", (b) => (c.options || [])[b.choice] ?? b.choice]];
  if (act.kind === "scale") return [["value", (b) => b.value]];
  if (act.kind === "sort") {
    return (c.items || []).map((it, i) => [it, (b) => {
      const j = (b.placements || [])[i];
      return j === null || j === undefined ? "" : (c.buckets || [])[j] ?? j;
    }]);
  }
  if (act.kind === "vote") {
    return [["round", (b) => b.round || 1], ["choice", (b) => (c.options || [])[b.choice] ?? b.choice],
      ["sure_1_to_3", (b) => b.confidence ?? ""]];
  }
  if (act.kind === "dots") return [["picks", (b) => (b.picks || []).join(";")], ["n_picks", (b) => (b.picks || []).length]];
  if (act.kind === "slider") return [["value_0_to_100", (b) => b.value]];
  if (act.kind === "qa") {
    return [["type", (b) => (b.upvote ? "upvote" : "question")], ["text", (b) => b.text ?? ""], ["upvote_of", (b) => b.upvote ?? ""]];
  }
  if (act.kind === "rank") {
    return (c.items || []).map((it, i) => [it, (b) => { const p = (b.order || []).indexOf(i); return p < 0 ? "" : p + 1; }]);
  }
  if (act.kind === "quiz") return [["answer", (b) => b.answer], ["correct", (b) => b.correct]];
  if (act.kind === "hotspot") {
    return [["points", (b) => (b.points || []).map((p) => `${p.x},${p.y}`).join(";")]];
  }
  if (act.kind === "ticket") return [["value", (b) => b.value], ["text", (b) => b.text]];
  return [["body", (b) => JSON.stringify(b)]];
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function activityCsvRows(space, act, responses, withHeader = true) {
  const cols = csvColumns(act);
  const head = ["created_at", "updated_at", "space", "activity_code", "activity_title", "kind", "group", "hidden", ...cols.map((c) => c[0])];
  const body = responses.map((r) => [
    r.created_at, r.updated_at, space.title, act.code, act.title, act.kind, r.group_label ?? "", r.hidden,
    ...cols.map((c) => c[1](r.body)),
  ]);
  return withHeader ? [head, ...body] : body;
}
