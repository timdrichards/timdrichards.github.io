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
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(n))); }

// ---------------------------------------------------------------- results

// Charts take only visible responses. `big` is the projector size.
export function renderResults(act, responses, { big = false } = {}) {
  const shown = responses.filter((r) => !r.hidden);
  const c = act.config || {};
  if (act.kind === "card") return renderCards(c, shown, big);
  if (act.kind === "poll") return renderPoll(c, shown);
  if (act.kind === "scale") return renderScale(c, shown);
  if (act.kind === "sort") return renderSort(c, shown);
  return "";
}

function emptyNote(n) {
  return n ? "" : `<p class="muted empty">No responses yet.</p>`;
}

function renderCards(c, rows, big) {
  const tags = c.tags || [];
  const card = (r) => `<div class="card-resp">${esc(r.body.text)}</div>`;
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
