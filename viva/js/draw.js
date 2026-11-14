// Viva drawing pad: an SVG editor for a mouse, a pen or a finger.
//
//   const pad = new Sketch(element, { scene, authoring, onChange });
//   pad.scene()        -> { w, h, items }   the drawing, as JSON
//   pad.hasWork()      -> true once the student has added anything (starter items do not count)
//   await pad.png()    -> "data:image/png;base64,..."   for the server and the AI
//   Sketch.svg(scene)  -> a read-only SVG string, for transcripts
//
// Tools: select and move (V), pen (P), box (R), ellipse (O), text (T), arrow (A), eraser (E);
// eight colors, two line widths, fill on or off, undo and redo, delete, clear.
// Arrows that start or end on a shape stay attached when the shape moves. Double-click (or
// double-tap) a shape or an arrow to label it. Starter items from the instructor are `locked`:
// students can draw on them and connect arrows to them, but cannot move, change or erase them.
// Once a pen touches the pad, finger touches no longer draw (palm rejection).
//
// Scene items (coordinates in a fixed 1000 x 625 space, scaled to fit):
//   {id, type: "rect"|"ellipse", x, y, w, h, color, fill, label, locked}
//   {id, type: "text", x, y, text, color, size, locked}
//   {id, type: "path", points: [[x, y], ...], color, width, straight?, locked}
//   {id, type: "arrow", from: {id} | {x, y}, to: {id} | {x, y}, color, width, label, locked}
//   {id, type: "stencil", ref, name, x, y, w, h, w0, h0, items, color?, label, locked}
//      a shape from the course's library (opts.stencils), placed as one piece. It keeps its own
//      copy of the library drawing (items, in a w0 x h0 box) scaled to w x h, so later edits to
//      the library never change a drawing already made. color, when set, recolors all of it.

export const W = 1000, H = 625;
export const COLORS = [
  ["#1f1f1f", "Black"], ["#2a78d6", "Blue"], ["#d43c3c", "Red"], ["#1d8f5a", "Green"],
  ["#e07a1f", "Orange"], ["#7b4fc9", "Purple"], ["#7a7a74", "Gray"], ["#c99a00", "Gold"],
];
const TOOLS = [
  ["select", "Select", "V", '<path d="M5 3l12 8-5 1.5L9.5 18z"/>'],
  ["pen", "Pen", "P", '<path d="M4 17c3-1 4-6 7-8s5-3 6-1-2 4-5 6-6 4-8 3z" fill="none"/>'],
  ["rect", "Box", "R", '<rect x="3.5" y="5.5" width="15" height="11" rx="1.5" fill="none"/>'],
  ["ellipse", "Ellipse", "O", '<ellipse cx="11" cy="11" rx="8" ry="5.5" fill="none"/>'],
  ["text", "Text", "T", '<path d="M5 5h12M11 5v13" fill="none"/>'],
  ["arrow", "Arrow", "A", '<path d="M4 17L17 5M10 5h7v7" fill="none"/>'],
  ["eraser", "Eraser", "E", '<path d="M8 18h10M4 13l7-8 6 6-6 7H9z" fill="none"/>'],
];
const SHAPES_ICON = '<path d="M3 9h7V3H3zM13 19a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 3l5.5 8H6.5z" fill="none"/>';
const MAX_ITEMS = 400, MAX_POINTS = 1500;

const uid = () => Math.random().toString(36).slice(2, 9);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r1 = (n) => Math.round(n * 10) / 10;
const tint = (hex) => hex + "26";   // the same color at about 15% opacity
const isShape = (it) => it && (it.type === "rect" || it.type === "ellipse" || it.type === "stencil");
// Library shapes keep their line widths when scaled.
const STYLE = "<style>.st *{vector-effect:non-scaling-stroke}</style>";

// ---------------------------------------------------------------- geometry

function box(it) {
  if (isShape(it)) return { x: it.x, y: it.y, w: it.w, h: it.h };
  if (it.type === "text") {
    const lines = String(it.text || "").split("\n");
    const size = it.size || 22;
    return { x: it.x, y: it.y - size * 0.85, w: Math.max(...lines.map((l) => l.length), 1) * size * 0.56, h: lines.length * size * 1.2 };
  }
  if (it.type === "path") {
    const xs = it.points.map((p) => p[0]), ys = it.points.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  return null;
}
const center = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

// Where the line from a shape's center toward (tx, ty) leaves the shape.
function edge(it, tx, ty) {
  const c = center(it);
  const dx = tx - c.x, dy = ty - c.y;
  if (!dx && !dy) return c;
  if (it.type === "ellipse") {
    const a = it.w / 2, b = it.h / 2;
    const t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  const t = Math.min(dx ? (it.w / 2) / Math.abs(dx) : Infinity, dy ? (it.h / 2) / Math.abs(dy) : Infinity);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

// The two ends of an arrow, clipped to the shapes they are attached to.
export function arrowEnds(it, byId) {
  const end = (e) => (e && e.id && isShape(byId.get(e.id))) ? byId.get(e.id) : null;
  const a = end(it.from), b = end(it.to);
  const pa = a ? center(a) : { x: it.from?.x ?? 0, y: it.from?.y ?? 0 };
  const pb = b ? center(b) : { x: it.to?.x ?? 0, y: it.to?.y ?? 0 };
  const s = a ? edge(a, pb.x, pb.y) : pa;
  const e = b ? edge(b, pa.x, pa.y) : pb;
  return { x1: s.x, y1: s.y, x2: e.x, y2: e.y };
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hits(it, x, y, byId, slop = 8) {
  if (isShape(it) || it.type === "text") {
    const b = box(it);
    return x >= b.x - slop && x <= b.x + b.w + slop && y >= b.y - slop && y <= b.y + b.h + slop;
  }
  if (it.type === "path") {
    for (let i = 1; i < it.points.length; i++) {
      const [x1, y1] = it.points[i - 1], [x2, y2] = it.points[i];
      if (segDist(x, y, x1, y1, x2, y2) <= slop + (it.width || 3) / 2) return true;
    }
    return it.points.length === 1 && Math.hypot(x - it.points[0][0], y - it.points[0][1]) <= slop;
  }
  if (it.type === "arrow") {
    const e = arrowEnds(it, byId);
    return segDist(x, y, e.x1, e.y1, e.x2, e.y2) <= slop + 2;
  }
  return false;
}

// ---------------------------------------------------------------- rendering

// Freehand strokes are smoothed; a path marked `straight` (outlines in library shapes) is not.
function pathD(points, straight = false) {
  if (!points.length) return "";
  if (points.length < 3 || straight) return "M" + points.map((p) => `${r1(p[0])} ${r1(p[1])}`).join(" L");
  let d = `M${r1(points[0][0])} ${r1(points[0][1])}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[i + 1];
    d += ` Q${r1(x1)} ${r1(y1)} ${r1((x1 + x2) / 2)} ${r1((y1 + y2) / 2)}`;
  }
  const last = points.at(-1);
  return d + ` L${r1(last[0])} ${r1(last[1])}`;
}

function labelSvg(text, x, y, color, size = 20, bg = false) {
  const lines = String(text || "").split("\n").filter((l, i, a) => l || a.length === 1);
  if (!text) return "";
  const top = y - ((lines.length - 1) * size * 1.15) / 2;
  const back = bg ? (() => {
    const w = Math.max(...lines.map((l) => l.length)) * size * 0.56 + 10, h = lines.length * size * 1.15 + 4;
    return `<rect x="${r1(x - w / 2)}" y="${r1(top - size * 0.85)}" width="${r1(w)}" height="${r1(h)}" rx="4" fill="#ffffff" fill-opacity=".9"/>`;
  })() : "";
  return back + `<text x="${r1(x)}" y="${r1(top)}" fill="${color}" font-size="${size}" text-anchor="middle" dominant-baseline="middle">${lines.map((l, i) =>
    `<tspan x="${r1(x)}" dy="${i ? size * 1.15 : 0}">${esc(l)}</tspan>`).join("")}</text>`;
}

// Where an arrow's label goes: on the middle of the arrow if nothing is in the way, otherwise
// beside it or further along it, wherever it covers the least. In the way: boxes (except one the
// label sits wholly inside, like a column), labels already placed, and other arrows' lines.
function labelSpot(text, e, byId, placed = [], lines = []) {
  const size = 18, rows = String(text).split("\n");
  const w = Math.max(...rows.map((l) => l.length)) * size * 0.56 + 10, h = rows.length * size * 1.15 + 4;
  const dx = e.x2 - e.x1, dy = e.y2 - e.y1, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const off = (w / 2) * Math.abs(nx) + (h / 2) * Math.abs(ny) + 5;
  const shapes = [...byId.values()].filter(isShape);
  const cost = (cx, cy) => {
    const L = cx - w / 2, R = cx + w / 2, T = cy - h / 2, B = cy + h / 2;
    const over = (x, y, ww, hh) => Math.max(0, Math.min(R, x + ww) - Math.max(L, x)) * Math.max(0, Math.min(B, y + hh) - Math.max(T, y));
    let c = (L < 0 || R > W || T < 0 || B > H) ? 1e6 : 0;
    for (const sh of shapes) {
      if (sh.x <= L && sh.x + sh.w >= R && sh.y <= T && sh.y + sh.h >= B) continue;
      c += over(sh.x - 6, sh.y - 6, sh.w + 12, sh.h + 12);   // keep a little clear of every box
    }
    for (const p of placed) c += 2 * over(p.x, p.y, p.w, p.h);
    for (const l of lines) for (let i = 0; i <= 12; i++) {
      const x = l.x1 + (l.x2 - l.x1) * i / 12, y = l.y1 + (l.y2 - l.y1) * i / 12;
      if (x > L && x < R && y > T && y < B) c += 150;
    }
    return c;
  };
  let best = null;
  for (const t of [0.5, 0.35, 0.65, 0.25, 0.75]) for (const side of [0, 1, -1]) for (const extra of [0, 22]) {
    if (!side && extra) continue;
    const d = side ? (off + extra) * side : 0;
    const cx = e.x1 + dx * t + nx * d, cy = e.y1 + dy * t + ny * d;
    const c = cost(cx, cy) + (side ? 40 + extra : 0) + Math.abs(t - 0.5) * 60;
    if (!best || c < best.c) best = { c, x: cx, y: cy, w, h };
  }
  return { x: best.x, y: best.y, box: { x: best.x - w / 2, y: best.y - h / 2, w, h } };
}

// A shape that contains other items shows its label along the top, like a header, so what is
// drawn inside does not cover it.
function itemSvg(it, byId, selected, holds = false, spot = null) {
  const sel = selected ? ' class="sel"' : "";
  const lock = it.locked ? ' data-locked="1"' : "";
  const c = it.color || "#1f1f1f";
  if (it.type === "rect") {
    return `<g data-id="${it.id}"${sel}${lock}><rect x="${r1(it.x)}" y="${r1(it.y)}" width="${r1(it.w)}" height="${r1(it.h)}" rx="6" fill="${it.fill ? tint(c) : "#ffffff"}" fill-opacity="${it.fill ? 1 : 0.01}" stroke="${c}" stroke-width="2.5"/>` +
      labelSvg(it.label, it.x + it.w / 2, holds ? it.y + 17 : it.y + it.h / 2, c) + "</g>";
  }
  if (it.type === "ellipse") {
    return `<g data-id="${it.id}"${sel}${lock}><ellipse cx="${r1(it.x + it.w / 2)}" cy="${r1(it.y + it.h / 2)}" rx="${r1(it.w / 2)}" ry="${r1(it.h / 2)}" fill="${it.fill ? tint(c) : "#ffffff"}" fill-opacity="${it.fill ? 1 : 0.01}" stroke="${c}" stroke-width="2.5"/>` +
      labelSvg(it.label, it.x + it.w / 2, holds ? it.y + Math.max(17, it.h * 0.12) : it.y + it.h / 2, c) + "</g>";
  }
  if (it.type === "stencil") {
    const sx = it.w / (it.w0 || it.w), sy = it.h / (it.h0 || it.h);
    const art = it.color ? (it.items || []).map((x) => ({ ...x, color: it.color })) : (it.items || []);
    const below = it.y + it.h + 16 <= H - 4;
    return `<g data-id="${it.id}"${sel}${lock}><g class="st" transform="translate(${r1(it.x)} ${r1(it.y)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})">${inner({ items: art })}</g>` +
      `<rect x="${r1(it.x)}" y="${r1(it.y)}" width="${r1(it.w)}" height="${r1(it.h)}" fill="#fff" fill-opacity="0.01"/>` +
      labelSvg(it.label, it.x + it.w / 2, below ? it.y + it.h + 15 : it.y - 13, it.color || c, 18, true) + "</g>";
  }
  if (it.type === "text") {
    const size = it.size || 22;
    return `<g data-id="${it.id}"${sel}${lock}><text x="${r1(it.x)}" y="${r1(it.y)}" fill="${c}" font-size="${size}">${String(it.text || "").split("\n").map((l, i) =>
      `<tspan x="${r1(it.x)}" dy="${i ? size * 1.2 : 0}">${esc(l)}</tspan>`).join("")}</text></g>`;
  }
  if (it.type === "path") {
    return `<g data-id="${it.id}"${sel}${lock}><path d="${pathD(it.points, it.straight)}" fill="none" stroke="${c}" stroke-width="${it.width || 3}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  if (it.type === "arrow") {
    const e = arrowEnds(it, byId);
    const ang = Math.atan2(e.y2 - e.y1, e.x2 - e.x1), hl = 14 + (it.width || 2.5) * 1.5;
    const p1 = [e.x2 - hl * Math.cos(ang - 0.42), e.y2 - hl * Math.sin(ang - 0.42)];
    const p2 = [e.x2 - hl * Math.cos(ang + 0.42), e.y2 - hl * Math.sin(ang + 0.42)];
    const sx = e.x2 - (hl * 0.7) * Math.cos(ang), sy = e.y2 - (hl * 0.7) * Math.sin(ang);
    return `<g data-id="${it.id}"${sel}${lock}><line x1="${r1(e.x1)}" y1="${r1(e.y1)}" x2="${r1(sx)}" y2="${r1(sy)}" stroke="${c}" stroke-width="${it.width || 2.5}" stroke-linecap="round"/>` +
      `<polygon points="${r1(e.x2)},${r1(e.y2)} ${r1(p1[0])},${r1(p1[1])} ${r1(p2[0])},${r1(p2[1])}" fill="${c}"/>` +
      `<line x1="${r1(e.x1)}" y1="${r1(e.y1)}" x2="${r1(e.x2)}" y2="${r1(e.y2)}" stroke="transparent" stroke-width="16"/>` +
      (it.label ? (() => { const p = spot || labelSpot(it.label, e, byId); return labelSvg(it.label, p.x, p.y, c, 18, true); })() : "") + "</g>";
  }
  return "";
}

function inner(scene, selected) {
  const items = scene.items || [];
  const byId = new Map(items.map((i) => [i.id, i]));
  // Shapes first, then strokes, text and arrows, so arrows and writing stay on top.
  const order = (t) => ({ rect: 0, ellipse: 0, stencil: 0, path: 1, text: 2, arrow: 3 })[t] ?? 4;
  const holders = new Set();
  for (const s of items) {
    if (!isShape(s)) continue;
    for (const o of items) {
      if (o === s || o.type === "arrow") continue;
      const b = box(o);
      if (!b || b.w * b.h >= s.w * s.h) continue;
      const c = center(b);
      if (c.x > s.x && c.x < s.x + s.w && c.y > s.y && c.y < s.y + s.h) { holders.add(s.id); break; }
    }
  }
  // Arrow labels are placed together, each avoiding the ones before it.
  const arrows = items.filter((i) => i.type === "arrow");
  const ends = new Map(arrows.map((a) => [a.id, arrowEnds(a, byId)]));
  const spots = new Map(), placed = [];
  for (const a of arrows) {
    if (!a.label) continue;
    const sp = labelSpot(a.label, ends.get(a.id), byId, placed, arrows.filter((o) => o !== a).map((o) => ends.get(o.id)));
    spots.set(a.id, sp); placed.push(sp.box);
  }
  return [...items].sort((a, b) => order(a.type) - order(b.type)).map((it) => itemSvg(it, byId, selected?.has(it.id), holders.has(it.id), spots.get(it.id))).join("");
}

// A small picture of a library shape, for the palette and the admin's Shapes page.
Sketch.thumb = function thumb(stencil) {
  const sc = stencil.scene || { w: 100, h: 100, items: [] };
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${sc.w + 4} ${sc.h + 4}" font-family="system-ui, sans-serif">${STYLE}<g class="st">${inner({ items: sc.items || [] })}</g></svg>`;
};

// A complete, self-contained SVG of a scene (white background), for transcripts and the PNG.
Sketch.svg = function svg(scene, { width } = {}) {
  const w = scene?.w || W, h = scene?.h || H;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"${width ? ` width="${width}"` : ""} font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">` +
    `${STYLE}<rect width="${w}" height="${h}" fill="#ffffff"/>${inner(scene || { items: [] })}</svg>`;
};

// ---------------------------------------------------------------- the editor

export function Sketch(host, opts = {}) {
  if (!(this instanceof Sketch)) return new Sketch(host, opts);
  const authoring = !!opts.authoring;
  let items = structuredClone(opts.scene?.items || []);
  const stencils = Array.isArray(opts.stencils) ? opts.stencils.filter((x) => x?.scene?.items?.length) : [];
  let tool = "pen", color = COLORS[0][0], width = 3, fill = false, stencilRef = null;
  let selected = new Set();
  let undo = [], redo = [];
  let drag = null;           // the gesture in progress
  let penSeen = false;       // palm rejection
  let lastTap = { t: 0, id: null };
  const touches = new Set();

  host.classList.add("sketch");
  host.innerHTML = `
    <div class="sk-bar" role="toolbar" aria-label="Drawing tools">
      <span class="sk-group">${TOOLS.map(([id, name, key, icon]) => `<button type="button" class="sk-tool" data-tool="${id}" title="${name} (${key})" aria-label="${name}">
        <svg viewBox="0 0 22 22" width="22" height="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="currentColor">${icon}</svg></button>`).join("")}</span>
      ${stencils.length ? `<span class="sk-group"><button type="button" class="sk-shapes" aria-expanded="false" title="Shapes from the course library" aria-label="Shapes">
        <svg viewBox="0 0 22 22" width="22" height="22" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SHAPES_ICON}</svg> Shapes</button></span>` : ""}
      <span class="sk-group">${COLORS.map(([c, n]) => `<button type="button" class="sk-color" data-color="${c}" title="${n}" aria-label="${n}" style="--c:${c}"></button>`).join("")}</span>
      <span class="sk-group">
        <button type="button" class="sk-width" data-width="3" title="Thin line" aria-label="Thin line"><span style="height:2px"></span></button>
        <button type="button" class="sk-width" data-width="6" title="Thick line" aria-label="Thick line"><span style="height:5px"></span></button>
        <button type="button" class="sk-fill" title="Fill shapes" aria-label="Fill shapes">Fill</button>
      </span>
      <span class="sk-group">
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)">Undo</button>
        <button type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)">Redo</button>
        <button type="button" data-act="delete" title="Delete selected (Delete)">Delete</button>
        <button type="button" data-act="clear" title="Clear everything you drew">Clear</button>
      </span>
    </div>
    ${stencils.length ? `<div class="sk-palette hidden" role="listbox" aria-label="Shapes">${stencils.map((st, i) =>
      `<button type="button" class="sk-stencil" data-stencil="${i}" title="${esc(st.name)}" role="option">${Sketch.thumb(st)}<span>${esc(st.name)}</span></button>`).join("")}</div>` : ""}
    <div class="sk-stage"><svg class="sk-svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif" tabindex="0" aria-label="Drawing area">
      ${STYLE}<rect class="sk-bg" width="${W}" height="${H}" fill="#ffffff"/><g class="sk-items"></g><g class="sk-live"></g><g class="sk-handles"></g></svg>
      <input class="sk-input hidden" type="text" maxlength="120" aria-label="Label"></div>
    <p class="sk-hint muted small"></p>`;
  const svgEl = host.querySelector(".sk-svg");
  const itemsEl = host.querySelector(".sk-items");
  const liveEl = host.querySelector(".sk-live");
  const handlesEl = host.querySelector(".sk-handles");
  const input = host.querySelector(".sk-input");
  const hint = host.querySelector(".sk-hint");

  const byId = () => new Map(items.map((i) => [i.id, i]));
  const editable = (it) => it && (authoring || !it.locked);
  const changed = () => opts.onChange?.(this);

  function snapshot() {
    undo.push(JSON.stringify(items));
    if (undo.length > 100) undo.shift();
    redo = [];
  }
  function render() {
    itemsEl.innerHTML = inner({ items }, selected);
    handlesEl.innerHTML = "";
    if (selected.size === 1) {
      const it = byId().get([...selected][0]);
      if (isShape(it) && editable(it)) {
        handlesEl.innerHTML = `<rect class="sk-handle" data-handle="se" x="${r1(it.x + it.w - 9)}" y="${r1(it.y + it.h - 9)}" width="18" height="18" rx="3"/>`;
      }
    }
    host.querySelectorAll(".sk-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
    host.querySelectorAll(".sk-stencil").forEach((b) => b.classList.toggle("on", tool === "stencil" && +b.dataset.stencil === stencilRef));
    host.querySelector(".sk-shapes")?.classList.toggle("on", tool === "stencil");
    host.querySelectorAll(".sk-color").forEach((b) => b.classList.toggle("on", b.dataset.color === color));
    host.querySelectorAll(".sk-width").forEach((b) => b.classList.toggle("on", +b.dataset.width === width));
    host.querySelector(".sk-fill").classList.toggle("on", fill);
    host.querySelector('[data-act="undo"]').disabled = !undo.length;
    host.querySelector('[data-act="redo"]').disabled = !redo.length;
    host.querySelector('[data-act="delete"]').disabled = ![...selected].some((id) => editable(byId().get(id)));
    svgEl.dataset.tool = tool;
    hint.textContent = {
      select: "Tap to select, drag to move, drag the corner square to resize. Double-tap a shape or arrow to label it.",
      pen: "Draw freely.",
      rect: "Drag to draw a box (or tap for a standard one), then type its label.",
      ellipse: "Drag to draw an ellipse (or tap), then type its label.",
      text: "Tap where the text goes, type, then press Enter.",
      arrow: "Drag from one shape to another to connect them. Arrows stay attached when shapes move.",
      eraser: "Tap or drag over anything you drew to erase it.",
      stencil: `Tap to place a ${stencils[stencilRef]?.name || "shape"} (or drag to size it), then type a label if you like. Arrows attach to it like a box.`,
    }[tool] + (authoring ? "" : items.some((i) => i.locked) ? " The starting diagram cannot be moved or erased, but you can draw on it and connect to it." : "");
  }
  this.render = render;

  function point(ev) {
    const m = svgEl.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return { x: Math.max(0, Math.min(W, p.x)), y: Math.max(0, Math.min(H, p.y)) };
  }
  function topAt(x, y, filter = () => true) {
    const map = byId();
    const order = (t) => ({ rect: 0, ellipse: 0, stencil: 0, path: 1, text: 2, arrow: 3 })[t];
    const sorted = [...items].sort((a, b) => order(b.type) - order(a.type));
    // Prefer small things over big containers under the same point.
    const hit = sorted.filter((it) => filter(it) && hits(it, x, y, map));
    hit.sort((a, b) => (order(b.type) - order(a.type)) || ((box(a)?.w * box(a)?.h || 0) - (box(b)?.w * box(b)?.h || 0)));
    return hit[0] || null;
  }
  const shapeAt = (x, y) => topAt(x, y, isShape);

  // ---------------------------------------------------------------- labels and text

  function editText(it, field) {
    const r = svgEl.getBoundingClientRect(), hr = host.querySelector(".sk-stage").getBoundingClientRect();
    const s = r.width / W;
    let cx, cy;
    if (it.type === "arrow") { const e = arrowEnds(it, byId()); cx = (e.x1 + e.x2) / 2; cy = (e.y1 + e.y2) / 2; }
    else if (it.type === "text") { cx = it.x + 80; cy = it.y - 6; }
    else if (it.type === "stencil") { cx = it.x + it.w / 2; cy = Math.min(H - 10, it.y + it.h + 15); }
    else { cx = it.x + it.w / 2; cy = it.y + it.h / 2; }
    input.style.left = `${r.left - hr.left + cx * s - 110}px`;
    input.style.top = `${r.top - hr.top + cy * s - 18}px`;
    input.value = it[field] || "";
    input.classList.remove("hidden");
    input.dataset.id = it.id; input.dataset.field = field;
    input.focus(); input.select();
    setTimeout(() => { if (document.activeElement !== input && !input.classList.contains("hidden")) input.focus(); }, 0);
  }
  function commitText() {
    if (input.classList.contains("hidden")) return;
    const it = byId().get(input.dataset.id);
    const field = input.dataset.field;
    input.classList.add("hidden");
    if (!it) return;
    const v = input.value.trim();
    if ((it[field] || "") === v) { if (it.type === "text" && !v) items = items.filter((x) => x !== it); render(); return; }
    snapshot();
    if (it.type === "text" && !v) items = items.filter((x) => x !== it);
    else it[field] = v;
    render(); changed();
  }
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); commitText(); svgEl.focus(); }
    if (ev.key === "Escape") { input.value = byId().get(input.dataset.id)?.[input.dataset.field] || ""; commitText(); }
    ev.stopPropagation();
  });
  input.addEventListener("blur", commitText);
  this.input = input;

  // ---------------------------------------------------------------- gestures

  svgEl.addEventListener("pointerdown", (ev) => {
    if (ev.button > 0) return;
    if (ev.pointerType === "pen") penSeen = true;
    if (ev.pointerType === "touch") {
      touches.add(ev.pointerId);
      if (penSeen || touches.size > 1) { drag = null; liveEl.innerHTML = ""; return; }
    }
    commitText();
    ev.preventDefault();
    svgEl.setPointerCapture?.(ev.pointerId);
    const p = point(ev);
    const now = performance.now();

    if (tool === "select") {
      const handle = ev.target.closest?.("[data-handle]");
      if (handle && selected.size === 1) {
        const it = byId().get([...selected][0]);
        snapshot();
        drag = { kind: "resize", it, ox: p.x, oy: p.y, w: it.w, h: it.h, moved: false };
        return;
      }
      const it = topAt(p.x, p.y);
      const double = it && lastTap.id === it.id && now - lastTap.t < 400;
      lastTap = { t: now, id: it?.id || null };
      if (double && editable(it) && (isShape(it) || it.type === "arrow" || it.type === "text")) {
        editText(it, it.type === "text" ? "text" : "label");
        return;
      }
      selected = it ? new Set([it.id]) : new Set();
      render();
      if (it && editable(it) && it.type !== "arrow") {
        drag = { kind: "move", it, ox: p.x, oy: p.y, start: structuredClone(it), moved: false };
      }
      return;
    }
    if (tool === "eraser") {
      drag = { kind: "erase", erased: false };
      eraseAt(p, drag);
      return;
    }
    if (tool === "pen") {
      drag = { kind: "pen", points: [[r1(p.x), r1(p.y)]] };
      liveEl.innerHTML = `<path d="" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
      return;
    }
    if (tool === "rect" || tool === "ellipse" || tool === "stencil") {
      drag = { kind: "shape", x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      return;
    }
    if (tool === "arrow") {
      const from = shapeAt(p.x, p.y);
      drag = { kind: "arrow", from: from ? { id: from.id } : { x: r1(p.x), y: r1(p.y) }, fx: p.x, fy: p.y, x: p.x, y: p.y };
      return;
    }
    if (tool === "text") {
      if (items.length >= MAX_ITEMS) return;
      snapshot();
      const it = { id: uid(), type: "text", x: r1(p.x), y: r1(p.y), text: "", color, size: 22, ...(authoring ? { locked: true } : {}) };
      items.push(it);
      render();
      editText(it, "text");
    }
  });

  svgEl.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    if (ev.pointerType === "touch" && (penSeen || touches.size > 1)) return;
    const p = point(ev);
    if (drag.kind === "pen") {
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
      for (const e of evs.length ? evs : [ev]) {
        const q = point(e);
        const last = drag.points.at(-1);
        if (Math.hypot(q.x - last[0], q.y - last[1]) >= 1.5 && drag.points.length < MAX_POINTS) drag.points.push([r1(q.x), r1(q.y)]);
      }
      liveEl.firstChild.setAttribute("d", pathD(drag.points));
    } else if (drag.kind === "shape") {
      drag.x1 = p.x; drag.y1 = p.y;
      const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y), w = Math.abs(p.x - drag.x0), h = Math.abs(p.y - drag.y0);
      liveEl.innerHTML = tool !== "ellipse"
        ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6 4"/>`
        : `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="none" stroke="${color}" stroke-width="2.5" stroke-dasharray="6 4"/>`;
    } else if (drag.kind === "arrow") {
      drag.x = p.x; drag.y = p.y;
      const target = shapeAt(p.x, p.y);
      const temp = { type: "arrow", from: drag.from, to: target && target.id !== drag.from.id ? { id: target.id } : { x: p.x, y: p.y }, color, width: width === 3 ? 2.5 : 4.5 };
      liveEl.innerHTML = itemSvg(temp, byId(), false) +
        (target && target.id !== drag.from.id ? `<rect x="${target.x - 4}" y="${target.y - 4}" width="${target.w + 8}" height="${target.h + 8}" rx="8" fill="none" stroke="${color}" stroke-opacity=".35" stroke-width="6"/>` : "");
    } else if (drag.kind === "move") {
      const dx = p.x - drag.ox, dy = p.y - drag.oy;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) { snapshot(); drag.moved = true; }
      const it = drag.it, s = drag.start;
      if (it.type === "path") it.points = s.points.map(([x, y]) => [r1(x + dx), r1(y + dy)]);
      else { it.x = r1(s.x + dx); it.y = r1(s.y + dy); }
      render();
    } else if (drag.kind === "resize") {
      drag.moved = true;
      drag.it.w = r1(Math.max(30, drag.w + p.x - drag.ox));
      drag.it.h = r1(Math.max(24, drag.h + p.y - drag.oy));
      render();
    } else if (drag.kind === "erase") {
      eraseAt(p, drag);
    }
  });

  const finish = (ev) => {
    if (ev.pointerType === "touch") touches.delete(ev.pointerId);
    if (!drag) return;
    const d = drag;
    drag = null;
    liveEl.innerHTML = "";
    if (d.kind === "pen") {
      if (items.length >= MAX_ITEMS) return;
      snapshot();
      items.push({ id: uid(), type: "path", points: d.points, color, width, ...(authoring ? { locked: true } : {}) });
      render(); changed();
    } else if (d.kind === "shape" && tool === "stencil") {
      const st = stencils[stencilRef];
      if (!st || items.length >= MAX_ITEMS) return;
      const w0 = st.scene.w || 100, h0 = st.scene.h || 100;
      let x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w < 12 && h < 12) {   // a tap: the shape at a standard size, keeping its proportions
        const k = 130 / Math.max(w0, h0);
        w = w0 * k; h = h0 * k;
        x = Math.max(0, Math.min(W - w, d.x0 - w / 2)); y = Math.max(0, Math.min(H - h, d.y0 - h / 2));
      }
      snapshot();
      const it = { id: uid(), type: "stencil", ref: st.id || "", name: st.name, x: r1(x), y: r1(y), w: r1(Math.max(24, w)), h: r1(Math.max(24, h)),
                   w0, h0, items: structuredClone(st.scene.items), label: "", ...(authoring ? { locked: true } : {}) };
      items.push(it);
      selected = new Set([it.id]);
      render(); changed();
      editText(it, "label");
    } else if (d.kind === "shape") {
      if (items.length >= MAX_ITEMS) return;
      let x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
      if (w < 12 && h < 12) { w = tool === "rect" ? 170 : 150; h = tool === "rect" ? 80 : 90; x = Math.min(W - w, d.x0 - w / 2); y = Math.min(H - h, d.y0 - h / 2); }
      snapshot();
      const it = { id: uid(), type: tool, x: r1(Math.max(0, x)), y: r1(Math.max(0, y)), w: r1(Math.max(30, w)), h: r1(Math.max(24, h)), color, fill, label: "", ...(authoring ? { locked: true } : {}) };
      items.push(it);
      selected = new Set([it.id]);
      render(); changed();
      editText(it, "label");
    } else if (d.kind === "arrow") {
      if (Math.hypot(d.x - d.fx, d.y - d.fy) < 10 || items.length >= MAX_ITEMS) return;
      const target = shapeAt(d.x, d.y);
      snapshot();
      items.push({ id: uid(), type: "arrow", from: d.from, to: target && target.id !== d.from.id ? { id: target.id } : { x: r1(d.x), y: r1(d.y) },
                   color, width: width === 3 ? 2.5 : 4.5, label: "", ...(authoring ? { locked: true } : {}) });
      render(); changed();
    } else if ((d.kind === "move" || d.kind === "resize") && d.moved) {
      changed();
    } else if (d.kind === "erase" && d.erased) {
      changed();
    }
  };
  svgEl.addEventListener("pointerup", finish);
  svgEl.addEventListener("pointercancel", (ev) => { if (ev.pointerType === "touch") touches.delete(ev.pointerId); drag = null; liveEl.innerHTML = ""; });

  function eraseAt(p, d) {
    const it = topAt(p.x, p.y, editable);
    if (!it) return;
    if (!d.erased) { snapshot(); d.erased = true; }
    remove(new Set([it.id]));
  }
  // Removing a shape also removes the arrows attached to it.
  function remove(ids) {
    const gone = new Map(items.filter((i) => ids.has(i.id) && isShape(i)).map((i) => [i.id, center(i)]));
    items = items.filter((i) => !ids.has(i.id) && !(i.type === "arrow" && editable(i) && (ids.has(i.from?.id) || ids.has(i.to?.id))));
    for (const i of items) if (i.type === "arrow") {
      for (const end of ["from", "to"]) if (gone.has(i[end]?.id)) { const c = gone.get(i[end].id); i[end] = { x: r1(c.x), y: r1(c.y) }; }
    }
    selected = new Set([...selected].filter((id) => !ids.has(id)));
    render();
  }

  // ---------------------------------------------------------------- toolbar and keys

  host.querySelector(".sk-bar").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    commitText();
    if (b.classList.contains("sk-shapes")) {
      const pal = host.querySelector(".sk-palette");
      const open = pal.classList.toggle("hidden") === false;
      b.setAttribute("aria-expanded", String(open));
      return;
    }
    if (b.dataset.tool) { tool = b.dataset.tool; if (tool !== "select") selected = new Set(); }
    if (b.dataset.color) {
      color = b.dataset.color;
      const sel = [...selected].map((id) => byId().get(id)).filter(editable);
      if (sel.length) { snapshot(); sel.forEach((it) => { it.color = color; }); changed(); }
    }
    if (b.dataset.width) {
      width = +b.dataset.width;
      const sel = [...selected].map((id) => byId().get(id)).filter((it) => editable(it) && (it.type === "path" || it.type === "arrow"));
      if (sel.length) { snapshot(); sel.forEach((it) => { it.width = it.type === "arrow" ? (width === 3 ? 2.5 : 4.5) : width; }); changed(); }
    }
    if (b.classList.contains("sk-fill")) {
      fill = !fill;
      const sel = [...selected].map((id) => byId().get(id)).filter((it) => editable(it) && isShape(it) && it.type !== "stencil");
      if (sel.length) { snapshot(); sel.forEach((it) => { it.fill = fill; }); changed(); }
    }
    const act = b.dataset.act;
    if (act === "undo" && undo.length) { redo.push(JSON.stringify(items)); items = JSON.parse(undo.pop()); selected = new Set(); changed(); }
    if (act === "redo" && redo.length) { undo.push(JSON.stringify(items)); items = JSON.parse(redo.pop()); selected = new Set(); changed(); }
    if (act === "delete") deleteSelected();
    if (act === "clear") {
      const mine = items.filter(editable);
      if (mine.length && confirm(authoring ? "Clear the whole diagram?" : "Erase everything you drew? The starting diagram stays.")) {
        snapshot(); remove(new Set(mine.map((i) => i.id))); changed();
      }
    }
    render();
  });
  host.querySelector(".sk-palette")?.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-stencil]");
    if (!b) return;
    commitText();
    tool = "stencil"; stencilRef = +b.dataset.stencil; selected = new Set();
    render();
  });
  function deleteSelected() {
    const ids = new Set([...selected].filter((id) => editable(byId().get(id))));
    if (!ids.size) return;
    snapshot(); remove(ids); changed();
  }
  svgEl.addEventListener("keydown", (ev) => {
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === "z") { ev.preventDefault(); host.querySelector(`[data-act="${ev.shiftKey ? "redo" : "undo"}"]`).click(); return; }
    if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSelected(); render(); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = TOOLS.find((x) => x[2].toLowerCase() === k);
    if (t) { tool = t[0]; render(); }
  });

  // ---------------------------------------------------------------- the outside

  this.scene = () => ({ w: W, h: H, items: structuredClone(items) });
  this.load = (scene) => { items = structuredClone(scene?.items || []); undo = []; redo = []; selected = new Set(); render(); };
  this.hasWork = () => items.some((i) => !i.locked);
  this.setTool = (t) => { tool = t; render(); };
  this.png = (scale = 1.2) => new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.round(W * scale); c.height = Math.round(H * scale);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL("image/png"));
    };
    img.onerror = () => no(new Error("Could not make an image of the drawing."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(Sketch.svg({ w: W, h: H, items }));
  });
  render();
}
