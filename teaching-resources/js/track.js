// Anonymous page-view counter for Teaching Resources.
// Sends: site, page, an audience tag from the link (?from=ta), the referring
// site's host, and a random per-browser id. No names, no cookies.
// Needs ../class-spaces/js/config.js loaded first (public anon key).
(function () {
  try {
    var cfg = window.CLASS_SPACES || {};
    var body = document.body;
    var site = body.getAttribute("data-site"), page = body.getAttribute("data-page");
    if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !site || !page) return;
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1") return;
    var params = new URLSearchParams(location.search);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && params.get("track") !== "1") return;

    var tag = (params.get("from") || "").toLowerCase();
    var src = null;
    try {
      if (/^[a-z0-9-]{1,40}$/.test(tag)) sessionStorage.setItem("tr-from", tag);
      src = sessionStorage.getItem("tr-from");
    } catch (e) { src = /^[a-z0-9-]{1,40}$/.test(tag) ? tag : null; }

    var refHost = null;
    try {
      if (document.referrer) {
        var h = new URL(document.referrer).hostname.toLowerCase();
        if (h && h !== location.hostname) refHost = h;
      }
    } catch (e) {}

    var visitor = null;
    try {
      visitor = localStorage.getItem("tr-visitor");
      if (!visitor && window.crypto && crypto.randomUUID) {
        visitor = crypto.randomUUID();
        localStorage.setItem("tr-visitor", visitor);
      }
    } catch (e) {}

    fetch(cfg.supabaseUrl + "/rest/v1/rpc/log_page_view", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseAnonKey,
        Authorization: "Bearer " + cfg.supabaseAnonKey,
      },
      body: JSON.stringify({ p_site: site, p_page: page, p_src: src, p_ref_host: refHost, p_visitor: visitor }),
    }).catch(function () {});
  } catch (e) {}
})();
