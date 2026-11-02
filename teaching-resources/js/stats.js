// Private stats view. Sign in with the Class Spaces admin account.
const cfg = window.CLASS_SPACES || {};
const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function table(rows, cols) {
  if (!rows.length) return "<p>No data yet.</p>";
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(c[1])}</th>`).join("")}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c[0]])}</td>`).join("")}</tr>`).join("")
  }</tbody></table>`;
}

async function showStats() {
  const site = document.getElementById("site").value;
  const days = Number(document.getElementById("days").value);
  const out = document.getElementById("out");
  out.innerHTML = "<p>Loading…</p>";
  const { data, error } = await sb.rpc("page_view_stats", { p_site: site, p_days: days });
  if (error) { out.innerHTML = `<p>Could not load stats: ${esc(error.message)}</p>`; return; }
  out.innerHTML = `
    <p><strong>${data.views}</strong> views from <strong>${data.visitors}</strong> browsers since ${esc(new Date(data.since).toLocaleDateString())}.</p>
    <h2>By page</h2>${table(data.by_page, [["page", "Page"], ["views", "Views"], ["visitors", "Browsers"]])}
    <h2>By audience tag</h2>${table(data.by_src, [["src", "?from="], ["views", "Views"], ["visitors", "Browsers"]])}
    <h2>By referring site</h2>${table(data.by_ref, [["ref_host", "Referrer"], ["views", "Views"]])}
    <h2>By day</h2>${table(data.by_day, [["day", "Day"], ["views", "Views"], ["visitors", "Browsers"]])}`;
}

async function render() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    app.innerHTML = `<form id="signin" class="stats-form">
      <label>Email <input name="email" type="email" required autocomplete="username"></label>
      <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
      <button type="submit">Sign in</button><p id="msg"></p></form>`;
    document.getElementById("signin").addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = e.target;
      const { error } = await sb.auth.signInWithPassword({ email: f.email.value.trim(), password: f.password.value });
      if (error) document.getElementById("msg").textContent = error.message; else render();
    });
    return;
  }
  app.innerHTML = `<div class="stats-form">
      <label>Section <select id="site"><option value="ta">TA resources</option><option value="hub">Hub page</option></select></label>
      <label>Last <select id="days"><option>7</option><option>30</option><option selected>90</option><option>365</option></select> days</label>
      <button id="go">Show</button> <button id="signout">Sign out</button></div><div id="out"></div>`;
  document.getElementById("go").addEventListener("click", showStats);
  document.getElementById("signout").addEventListener("click", async () => { await sb.auth.signOut(); render(); });
  showStats();
}
render();
