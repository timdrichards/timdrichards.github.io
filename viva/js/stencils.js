// Viva's starter set of shapes for COMPSCI 326. The admin's Shapes page adds these to a course's
// library with one button; after that the instructor edits, adds and removes shapes there, and
// these definitions are not used again. Each shape is a small drawing in the pad's item types
// (see js/draw.js), in its own coordinates; normalize() moves it to start at (0, 0).

const K = "#1f1f1f";
const r = (x, y, w, h, extra = {}) => ({ type: "rect", x, y, w, h, color: K, fill: false, label: "", ...extra });
const e = (x, y, w, h, extra = {}) => ({ type: "ellipse", x, y, w, h, color: K, fill: false, label: "", ...extra });
// Outlines are straight polylines; arcs are dense enough to look round either way.
const p = (points, extra = {}) => ({ type: "path", points, color: K, width: 3, straight: true, ...extra });
const t = (x, y, text, size = 16, extra = {}) => ({ type: "text", x, y, text, color: K, size, ...extra });
const arc = (cx, cy, rx, ry, a0, a1, n = 18) =>
  Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)]; });
const doc = () => [p([[0, 0], [85, 0], [110, 25], [110, 130], [0, 130], [0, 0]]), p([[85, 0], [85, 25], [110, 25]])];

// Move a shape's drawing so its bounding box starts at (4, 4), and record its size.
export function normalize(items) {
  const xs = [], ys = [];
  for (const it of items) {
    if (it.type === "path") it.points.forEach(([x, y]) => { xs.push(x); ys.push(y); });
    else if (it.type === "text") { const s = it.size || 16; xs.push(it.x, it.x + String(it.text).length * s * 0.56); ys.push(it.y - s * 0.85, it.y + s * 0.3); }
    else if (it.type === "arrow") { for (const end of [it.from, it.to]) if (end && end.x != null) { xs.push(end.x); ys.push(end.y); } }
    else { xs.push(it.x, it.x + it.w); ys.push(it.y, it.y + it.h); }
  }
  const x0 = Math.min(...xs) - 4, y0 = Math.min(...ys) - 4;
  const out = items.map((it, i) => {
    const c = { ...it, id: it.id || `s${i}` };
    delete c.locked;
    if (c.type === "path") c.points = c.points.map(([x, y]) => [Math.round((x - x0) * 10) / 10, Math.round((y - y0) * 10) / 10]);
    else if (c.type === "arrow") { for (const end of ["from", "to"]) if (c[end]?.x != null) c[end] = { x: c[end].x - x0, y: c[end].y - y0 }; }
    else { c.x = Math.round((c.x - x0) * 10) / 10; c.y = Math.round((c.y - y0) * 10) / 10; }
    return c;
  });
  return { w: Math.ceil(Math.max(...xs) - x0 + 4), h: Math.ceil(Math.max(...ys) - y0 + 4), items: out };
}

const S = (name, items) => ({ name, scene: normalize(items) });

export const STARTER = [
  S("Browser", [r(0, 0, 170, 115), p([[0, 24], [170, 24]], { width: 2 }), e(8, 8, 9, 9), e(21, 8, 9, 9), e(34, 8, 9, 9), r(52, 6, 108, 12, { color: "#7a7a74" })]),
  S("Express server", [r(0, 0, 130, 130), p([[0, 43], [130, 43]], { width: 2 }), p([[0, 86], [130, 86]], { width: 2 }),
    e(106, 17, 9, 9, { fill: true, color: "#1d8f5a" }), e(106, 60, 9, 9, { fill: true, color: "#1d8f5a" }), e(106, 103, 9, 9, { fill: true, color: "#1d8f5a" }),
    t(10, 27, "express", 17)]),
  S("Database", [e(0, 0, 120, 32), p([[0, 16], [0, 104]]), p([[120, 16], [120, 104]]), p(arc(60, 104, 60, 16, 0, Math.PI)), p(arc(60, 60, 60, 16, 0, Math.PI), { width: 2 })]),
  S("User", [e(22, 0, 30, 30), p([[37, 30], [37, 75]]), p([[12, 48], [62, 48]]), p([[37, 75], [17, 108]]), p([[37, 75], [57, 108]])]),
  S("Laptop", [r(15, 0, 130, 85), p([[0, 97], [160, 97], [148, 85], [12, 85], [0, 97]])]),
  S("Middleware", [p([[0, 0], [120, 0], [75, 55], [75, 95], [45, 95], [45, 55], [0, 0]])]),
  S("Queue", [r(0, 0, 200, 50), p([[50, 0], [50, 50]], { width: 2 }), p([[100, 0], [100, 50]], { width: 2 }), p([[150, 0], [150, 50]], { width: 2 }),
    p([[-40, 25], [-8, 25]], { width: 2 }), p([[-16, 17], [-8, 25], [-16, 33]], { width: 2 }), p([[208, 25], [240, 25]], { width: 2 }), p([[232, 17], [240, 25], [232, 33]], { width: 2 })]),
  S("Call stack", [p([[0, 0], [0, 150], [110, 150], [110, 0]]), p([[0, 112], [110, 112]], { width: 2 }), p([[0, 75], [110, 75]], { width: 2 }), p([[0, 38], [110, 38]], { width: 2 })]),
  S("JSON", [...doc(), t(22, 85, "{ }", 34)]),
  S("HTML page", [...doc(), t(18, 85, "</>", 30)]),
  S("File", [...doc(), p([[18, 50], [92, 50]], { width: 2 }), p([[18, 72], [92, 72]], { width: 2 }), p([[18, 94], [70, 94]], { width: 2 })]),
  S("Cookie", [e(0, 0, 80, 80, { color: "#a0662a" }), e(20, 18, 9, 9, { fill: true, color: "#5a3a1a" }), e(48, 28, 9, 9, { fill: true, color: "#5a3a1a" }),
    e(26, 50, 9, 9, { fill: true, color: "#5a3a1a" }), e(54, 56, 7, 7, { fill: true, color: "#5a3a1a" })]),
  S("Internet", [p([...arc(40, 70, 30, 30, Math.PI * 0.5, Math.PI * 1.5), ...arc(75, 40, 38, 38, Math.PI, Math.PI * 1.85), ...arc(125, 55, 32, 32, Math.PI * 1.35, Math.PI * 2.5),
    [40, 100]])]),
  S("Event loop", [p(arc(60, 60, 55, 55, Math.PI * 0.15, Math.PI * 1.85, 30)), p([[100, 33], [111, 39], [112.5, 26.5]])]),
  S("Timer", [e(0, 0, 90, 90), p([[45, 45], [45, 16]]), p([[45, 45], [66, 55]]), r(38, -10, 14, 8, { fill: true })]),
];
