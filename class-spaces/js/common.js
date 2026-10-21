// Shared helpers for the student and admin pages.

const cfg = window.CLASS_SPACES || {};

export const configured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

export const sb = configured
  ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// localStorage can be missing or throw (private windows, blocked storage).
const memory = new Map();
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? (memory.has(key) ? memory.get(key) : fallback) : JSON.parse(v);
    } catch {
      return memory.has(key) ? memory.get(key) : fallback;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* memory only */ }
  },
};

// A random id per browser, used only for the per-device limit.
export function deviceId() {
  let id = store.get("cs.device");
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    store.set("cs.device", id);
  }
  return id;
}

// The student link for an activity code: <site>/?code
export function studentUrl(code) {
  const base = new URL("./", location.href);
  base.search = "";
  base.hash = "";
  return base.href + "?" + code;
}

export function shortLabel(url) {
  return url.replace(/^https?:\/\//, "");
}

export function qrSvg(text, cellSize = 8) {
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize, margin: 2, scalable: true });
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function notConfiguredHtml() {
  return `<div class="panel"><h1>Class Spaces is not set up yet</h1>
    <p>Fill in <code>js/config.js</code> with the Supabase project URL and anon key. See the README.</p></div>`;
}

// Supabase returns at most 1000 rows per request; page through the rest.
export async function fetchAll(build, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < pageSize) return rows;
  }
}

export function errorText(e) {
  return (e && (e.message || e.error_description)) || String(e);
}
