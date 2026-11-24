// view.js: draws the world as SVG. Nothing is drawn that isn't in the world object,
// so the picture can never disagree with the terminal. Events from the last command
// (a request, a build, a container starting) are drawn on top as short animations.

const NS = "http://www.w3.org/2000/svg";
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function draw(svg, w, events = [], prev = null) {
  const W = 760;
  // What this command added: drawn with a glow and a "new" tag.
  const isNew = (kind, key) => !!prev && !prev[kind][key];
  const tag = (x, y) => `<g class="newtag"><rect x="${x}" y="${y}" width="30" height="14" rx="7"/><text x="${x + 15}" y="${y + 10.5}" text-anchor="middle">new</text></g>`;
  const images = Object.values(w.images);
  const nets = Object.values(w.networks).filter((n) => !n.builtin || Object.values(w.containers).some((c) => c.networks.includes(n.name)));
  const vols = Object.values(w.volumes);
  const containers = Object.values(w.containers);
  const parts = [];
  const pos = {}; // container id -> {x, y, w, h}

  // The laptop frame and its ports along the top edge.
  let y = 16;
  parts.push(`<text x="16" y="${y + 14}" class="h">your laptop</text>`);
  const hostPorts = Object.entries(w.host.ports);
  parts.push(`<text x="${W - 16}" y="${y + 14}" class="q" text-anchor="end">${hostPorts.length ? "published ports: " + hostPorts.map(([p]) => "localhost:" + p).join("  ") : "no ports published"}</text>`);
  y += 32;

  // Images, each a stack of layer bars (the last build coloured by what it reused).
  parts.push(`<text x="16" y="${y + 12}" class="sub">Images</text><text x="72" y="${y + 12}" class="q">recipes, built but not running: a stack of layers, one per Dockerfile line</text>`);
  y += 20;
  let x = 16, rowH = 0;
  for (const img of images) {
    const layers = img.layers.slice(-8);
    const bw = 200, bh = 16 + layers.length * 15 + 8;
    if (x + bw > W - 16) { x = 16; y += rowH + 12; rowH = 0; }
    const last = w.lastBuild && w.lastBuild.image === img.name;
    const fresh = isNew("images", img.name) || events.some((e) => e.type === "build" && e.image === img.name);
    parts.push(`<g class="image${fresh ? " is-new" : ""}"><rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="6" class="box"/>`);
    if (fresh) parts.push(tag(x + bw - 36, y - 7));
    const iname = img.name.replace(/:latest$/, "");
    parts.push(`<text x="${x + 8}" y="${y + 13}" class="n"><title>${esc(iname)}</title>${esc(iname.length > 24 ? iname.slice(0, 23) + "…" : iname)}</text>`);
    layers.forEach((l, i) => {
      const ly = y + bh - 8 - (i + 1) * 15;
      const cls = !last ? "layer" : l.status === "cached" ? "layer cached" : l.status === "built" ? "layer built" : "layer";
      parts.push(`<rect x="${x + 8}" y="${ly}" width="${bw - 16}" height="12" rx="2" class="${cls}" style="animation-delay:${i * 60}ms"/><text x="${x + 12}" y="${ly + 9}" class="l">${esc(l.text.slice(0, 30))}</text>`);
    });
    parts.push(`</g>`);
    x += bw + 12;
    rowH = Math.max(rowH, bh);
  }
  if (!images.length) { parts.push(`<text x="16" y="${y + 12}" class="q">None yet. docker build makes one from a Dockerfile; docker run pulls one if it needs to.</text>`); rowH = 18; }
  y += rowH + 24;

  // Networks, each a dashed region holding its containers.
  for (const n of nets) {
    const members = containers.filter((c) => c.networks.includes(n.name));
    const rows = Math.max(1, Math.ceil(members.length / 3));
    const h = 34 + rows * 92;
    parts.push(`<rect x="16" y="${y}" width="${W - 32}" height="${h}" rx="10" class="net"/>`);
    parts.push(`<text x="28" y="${y + 18}" class="sub">Network ${esc(n.name)}</text><text x="${36 + n.name.length * 7 + 60}" y="${y + 18}" class="q">${n.dns ? "containers here find each other by name" : "Docker's default: containers here can't find each other by name"}</text>`);
    members.forEach((c, i) => {
      const cx = 32 + (i % 3) * 240, cy = y + 30 + Math.floor(i / 3) * 92, cw = 224, ch = 80;
      pos[c.id] = { x: cx, y: cy, w: cw, h: ch, netTop: y };
      const state = c.state !== "running" ? "stopped" : c.program === "postgres" && !c.ready ? "starting" : "running";
      const flash = events.some((e) => (e.type === "start" || e.type === "exec") && e.id === c.id) ? " flash" : "";
      const fresh = isNew("containers", c.id);
      parts.push(`<g class="ctr ${state}${flash}${fresh ? " is-new" : ""}"><rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="8" class="box"/>`);
      if (fresh) parts.push(tag(cx + cw - 36, cy - 7));
      parts.push(`<text x="${cx + 10}" y="${cy + 18}" class="n">${esc(c.name)}</text>`);
      parts.push(`<text x="${cx + 10}" y="${cy + 34}" class="l2">${esc(c.image.replace(/:latest$/, ""))}</text>`);
      const ip = c.ip[n.name] ? `${c.ip[n.name]}` : "";
      const stateWords = state === "starting" ? "starting: not ready yet" : state === "stopped" ? `stopped${c.exitCode ? ` (exit ${c.exitCode})` : ""}` : "running";
      parts.push(`<text x="${cx + 10}" y="${cy + 50}" class="l2 st-${state}">${stateWords}${ip ? " · " + ip : ""}</text>`);
      parts.push(`<text x="${cx + 10}" y="${cy + 66}" class="l2">${c.listen && c.state === "running" ? "listens on " + c.listen.join(", ") + " · own localhost" : "own localhost"}</text>`);
      parts.push(`</g>`);
    });
    y += h + 16;
  }
  if (!containers.length) { parts.push(`<text x="16" y="${y + 4}" class="sub">Containers</text><text x="96" y="${y + 4}" class="q">None running. docker run starts one: a running copy of an image, in its own box.</text>`); y += 24; }

  // Port pipes from the top edge into containers.
  for (const [port, id] of hostPorts) {
    const p = pos[id];
    if (!p) continue;
    const px = p.x + p.w - 40;
    // A pipe through the network's edge into the container: the laptop's port, connected in.
    parts.push(`<path d="M${px} ${p.netTop - 10} V${p.y}" class="pipe"/><circle cx="${px}" cy="${p.netTop - 10}" r="4" class="portdot"/><text x="${px + 8}" y="${p.netTop - 6}" class="q">laptop :${port} → ${(w.containers[id].ports.find((x) => x.host === Number(port)) || {}).container}</text>`);
  }

  // Volumes along the bottom, with a line to each container that mounts one.
  if (vols.length) {
    parts.push(`<text x="16" y="${y + 12}" class="sub">Volumes</text><text x="76" y="${y + 12}" class="q">saved data, kept outside every container: it survives when containers are removed</text>`);
    y += 22;
    vols.forEach((v, i) => {
      const vx = 16 + (i % 4) * 182, vy = y + Math.floor(i / 4) * 64;
      const freshV = isNew("volumes", v.name);
      if (freshV) parts.push(tag(vx + 128, vy - 8));
      parts.push(`<g class="vol${v.anonymous ? " anon" : ""}${freshV ? " is-new" : ""}"><ellipse cx="${vx + 80}" cy="${vy + 8}" rx="80" ry="7" class="box"/><path d="M${vx} ${vy + 8} V${vy + 40} A80 7 0 0 0 ${vx + 160} ${vy + 40} V${vy + 8}" class="box"/>`);
      const tables = Object.keys(v.data.tables || {});
      parts.push(`<text x="${vx + 80}" y="${vy + 30}" text-anchor="middle" class="l2">${esc(v.anonymous ? "unnamed " + v.name.slice(0, 8) + "…" : v.name)}</text>`);
      parts.push(`<text x="${vx + 80}" y="${vy + 44}" text-anchor="middle" class="l">${tables.length ? "tables: " + esc(tables.join(", ")) : v.data.initialized ? "database files" : "empty"}</text></g>`);
      for (const c of containers) {
        if (c.mounts.some((m) => m.source === v.name) && pos[c.id]) {
          const p = pos[c.id];
          parts.push(`<path d="M${p.x + 30} ${p.y + p.h} L${vx + 80} ${vy}" class="mount"/>`);
        }
      }
    });
    y += Math.ceil(vols.length / 4) * 64;
  }

  // Requests from the last command: a dot that arrives, or a cross where it failed.
  for (const e of events.filter((e) => e.type === "request")) {
    const to = e.to && pos[e.to];
    const hp = e.from === "host" && pos[e.to] ? { x: pos[e.to].x + pos[e.to].w - 40, y: pos[e.to].netTop - 10 } : { x: W - 60, y: 40 };
    const from = e.from === "host" ? hp : pos[e.from] ? { x: pos[e.from].x + pos[e.from].w / 2, y: pos[e.from].y + pos[e.from].h / 2 } : null;
    if (!from) continue;
    if (to && e.ok) {
      const tx = to.x + to.w / 2, ty = to.y + to.h / 2;
      parts.push(`<circle r="6" class="dot ok"><animateMotion dur="0.9s" fill="freeze" path="M${from.x} ${from.y} L${tx} ${ty}"/></circle>`);
    } else {
      const tx = to ? to.x + to.w / 2 : from.x - 40, ty = to ? to.y + to.h / 2 : from.y + 40;
      const msg = `✕ ${e.error || "refused"}`, lx = to ? to.x : tx - 20, ly = to ? to.y + to.h + 6 : ty + 6;
      parts.push(`<path d="M${from.x} ${from.y} L${tx} ${ty}" class="fail"/><text x="${tx}" y="${ty + 5}" text-anchor="middle" class="bad">✕</text>`);
      parts.push(`<rect x="${lx}" y="${ly}" width="${Math.min(360, msg.length * 6.4 + 12)}" height="18" rx="4" class="failbox"/><text x="${lx + 6}" y="${ly + 13}" class="bad">${esc(msg)}</text>`);
    }
  }

  const H = y + 24;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = parts.join("");
}

// A plain-words account of the last command's events, for the log and for screen readers.
export function narrate(w, events) {
  const name = (id) => (w.containers[id] ? w.containers[id].name : "a removed container");
  return events.map((e) => {
    switch (e.type) {
      case "pull": return `Pulled the image ${e.image}.`;
      case "build": {
        const c = e.layers.filter((l) => l.status === "cached").length, b = e.layers.filter((l) => l.status === "built").length;
        return `Built ${e.image.replace(/:latest$/, "")}: ${c} layer${c === 1 ? "" : "s"} reused from the cache, ${b} built.`;
      }
      case "create": return `Created container ${name(e.id)}.`;
      case "start": return `Started ${name(e.id)}.`;
      case "ready": return `${name(e.id)}: the database is ready.`;
      case "exit": return `${e.name || name(e.id)} stopped (exit ${e.code}).`;
      case "remove": return `Removed container ${e.name}.`;
      case "volume": return `Created volume ${e.name}.`;
      case "remove-volume": return `Removed volume ${e.name}.`;
      case "network": return `Created network ${e.name}: containers on it find each other by name.`;
      case "exec": return `Ran "${e.cmd}" inside ${name(e.id)}.`;
      case "request":
        return e.from === "host"
          ? e.ok ? `The laptop's port ${e.port} reached ${name(e.to)}.` : `Nothing answers on the laptop's port ${e.port}.`
          : e.ok ? `${name(e.from)} reached ${name(e.to)} on port ${e.port}.` : `${name(e.from)} could not connect: ${e.error}.`;
      default: return "";
    }
  }).filter(Boolean);
}
