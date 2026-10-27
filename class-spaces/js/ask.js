// The FAQ assistant's student page (ask.html?<join code>).
// No login. A random device id (shared with Class Spaces) and a visit id go with each
// question, so the per-device limits work and the dashboard can count visits; no name is sent.

import { sb, configured, esc, store, deviceId, notConfiguredHtml, errorText } from "./common.js";

const app = document.getElementById("app");
const cfg = window.CLASS_SPACES || {};
const FN_URL = cfg.faqFunctionUrl || `${String(cfg.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/faq-ask`;
const FAQ_PAGE = "https://umamherst.instructure.com/courses/38092/pages/frequently-asked-questions";
const VISIT_IDLE_MS = 30 * 60 * 1000;   // a new visit after 30 minutes away
const BEAT_MS = 30 * 1000;              // keep the visit's last-seen time while the page is in view
const device = deviceId();
const turns = [];                       // the last exchanges, sent along for follow-ups
let code = null;

const kind = () => {
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && innerWidth < 640) return "phone";
  if (touch && innerWidth < 1100) return "tablet";
  return "desktop";
};

function visitId(fresh = false) {
  const v = store.get("faq.visit");
  if (!fresh && v && Date.now() - v.last < VISIT_IDLE_MS) {
    store.set("faq.visit", { id: v.id, last: Date.now() });
    return v.id;
  }
  const id = crypto.randomUUID ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
  store.set("faq.visit", { id, last: Date.now() });
  return id;
}

async function touch() {
  if (!code || document.visibilityState !== "visible") return;
  try { await sb.rpc("faq_touch", { p_code: code, p_session: visitId(), p_device: device, p_kind: kind() }); } catch { /* best effort */ }
}

// Safe formatting: everything is escaped first. Prose gets **bold**, `code`, "- " lists and
// paragraphs; fenced blocks (```js ... ```) become code blocks, highlighted by highlight.js
// (vendor/highlight-11.9.0.min.js) with a Copy button.
const LANGS = { js: "javascript", javascript: "javascript", mjs: "javascript", node: "javascript", ts: "typescript",
  ejs: "xml", html: "xml", xml: "xml", css: "css", json: "json", bash: "bash", sh: "bash", shell: "bash",
  console: "bash", zsh: "bash", sql: "sql", text: "plaintext", txt: "plaintext" };
const LABELS = { javascript: "JavaScript", typescript: "TypeScript", xml: "HTML", css: "CSS", json: "JSON", bash: "Terminal", sql: "SQL", plaintext: "Text" };

function prose(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  return String(text).trim().split(/\n{2,}/).filter((p) => p.trim()).map((p) => {
    const lines = p.split("\n");
    if (lines.every((l) => /^\s*[-*] /.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`;
    return `<p>${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

export function format(text) {
  let src = String(text ?? "");
  if ((src.match(/```/g) || []).length % 2) src += "\n```";      // an answer cut off inside a block
  const parts = src.split(/```([\w+-]*)[^\S\n]*\n?([\s\S]*?)```/);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    html += prose(parts[i]);
    if (i + 1 < parts.length) {
      const tag = (parts[i + 1] || "").toLowerCase();
      const lang = LANGS[tag] || "";
      const code = parts[i + 2].replace(/\n+$/, "");
      html += `<div class="ask-code"><div class="ask-code-bar"><span>${esc(tag === "ejs" ? "EJS" : LABELS[lang] || "Code")}</span>
        <button type="button" class="link small" data-copy>Copy</button></div>
        <pre><code${lang ? ` class="language-${lang}"` : ""}>${esc(code)}</code></pre></div>`;
    }
  }
  return html;
}

// Highlight the code blocks in one answer and wire their Copy buttons.
function dressCode(box) {
  box.querySelectorAll(".ask-code").forEach((block) => {
    const code = block.querySelector("code");
    try {
      if (window.hljs) {
        window.hljs.configure({ ignoreUnescapedHTML: true });
        if (code.className) window.hljs.highlightElement(code);
        else code.innerHTML = window.hljs.highlightAuto(code.textContent, ["javascript", "xml", "css", "bash", "json"]).value;
        code.classList.add("hljs");
      }
    } catch { /* plain text is fine */ }
    const btn = block.querySelector("[data-copy]");
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(code.textContent); btn.textContent = "Copied"; }
      catch { btn.textContent = "Select and copy"; }
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    };
  });
}

if (!configured) {
  app.innerHTML = notConfiguredHtml();
} else {
  start().catch((e) => { app.innerHTML = `<div class="panel narrow"><p class="error">${esc(errorText(e))}</p></div>`; });
}

async function start() {
  const fromUrl = decodeURIComponent(location.search.replace(/^\?/, "")).trim().toLowerCase();
  const candidate = fromUrl || store.get("faq.code");
  if (!candidate) return askForCode();
  const { data, error } = await sb.rpc("faq_info", { p_code: candidate });
  if (error) throw error;
  if (!data?.ok) return askForCode(fromUrl ? "That join code is not right. Check the link on Canvas." : "");
  store.set("faq.code", candidate);
  code = candidate;
  if (!data.open) return showClosed();
  showChat(data);
  touch();
  setInterval(touch, BEAT_MS);
  document.addEventListener("visibilitychange", touch);
}

function askForCode(msg = "") {
  app.innerHTML = `<div class="panel narrow">
    <h1>326 FAQ Assistant</h1>
    <form id="code" class="stack-form">
      <label>Join code<input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
      <p class="error">${esc(msg)}</p>
      <button class="primary">Start</button>
    </form>
    <p class="muted small">The code is on the FAQ page on Canvas.</p></div>`;
  app.querySelector("#code").onsubmit = (e) => {
    e.preventDefault();
    const c = e.target.code.value.trim().toLowerCase();
    window.history.replaceState(null, "", `?${encodeURIComponent(c)}`);
    start().catch((err) => askForCode(errorText(err)));
  };
}

function showClosed() {
  app.innerHTML = `<div class="panel narrow"><h1>326 FAQ Assistant</h1>
    <p>The assistant is closed right now.</p>
    <p>Every answer it gives comes from the <a href="${FAQ_PAGE}" target="_blank" rel="noopener">course FAQ on Canvas</a>, so start there.</p></div>`;
}

const EXAMPLES = ["My Mongo login keeps getting rejected", "Explain the code in Unit 8", "Who do I message for an extension?"];

// The chat: a header, the conversation (the only part that scrolls), and the question box
// pinned to the bottom, like a chat app.
function showChat(info) {
  const updated = info.faq_updated_at
    ? new Date(info.faq_updated_at).toLocaleDateString([], { month: "short", day: "numeric" }) : null;
  app.innerHTML = `<div class="ask-app">
    <header class="ask-head"><div class="ask-col">
      <h1>326 FAQ Assistant</h1>
      <p class="muted small">Answers from the <a href="${FAQ_PAGE}" target="_blank" rel="noopener">course FAQ</a>, the syllabus and the unit pages${
        updated ? `<span class="wide-only"> (updated ${esc(updated)})</span>` : ""}.<span class="wide-only"> It explains ideas and the course's code; it won't write your code or answer quiz questions.</span></p>
    </div></header>
    <div class="ask-scroll" id="scroll"><div class="ask-col">
      <div class="ask-empty" id="empty">
        <p class="muted">Ask anything about the course, a unit, its code or an error. For example:</p>
        <div class="btns">${EXAMPLES.map((x) => `<button type="button" class="small" data-example="${esc(x)}">${esc(x)}</button>`).join("")}</div>
      </div>
      <ol class="ask-log" id="log" aria-live="polite"></ol>
    </div></div>
    <form id="ask" class="ask-composer"><div class="ask-col">
      <div class="ask-box">
        <label class="sr" for="q">Your question</label>
        <textarea id="q" name="q" rows="1" maxlength="1000" placeholder="Ask a question about 326…" required></textarea>
        <button class="primary ask-send" id="send" aria-label="Ask">Ask</button>
      </div>
      <p class="error" id="err"></p>
      <div class="ask-foot muted small">
        <span>Saved <strong>without your name</strong>.<span class="wide-only"> Nothing personal; grades and extensions go to the Canvas Inbox.</span></span>
        <span class="spacer"></span><span id="count"></span>
        <button type="button" class="link small" id="fresh">New conversation</button>
      </div>
    </div></form>
  </div>`;
  const form = app.querySelector("#ask");
  const q = app.querySelector("#q");
  const grow = () => { q.style.height = "auto"; q.style.height = `${Math.min(q.scrollHeight, innerHeight * 0.35)}px`; };
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  q.addEventListener("input", () => {
    grow();
    app.querySelector("#count").textContent = q.value.length > 800 ? `${q.value.length}/1000` : "";
  });
  app.querySelectorAll("[data-example]").forEach((b) => { b.onclick = () => { q.value = b.dataset.example; grow(); ask(q.value); }; });
  app.querySelector("#fresh").onclick = () => {
    turns.length = 0;
    app.querySelector("#log").innerHTML = "";
    app.querySelector("#empty").hidden = false;
    visitId(true);
    touch();
    q.focus();
  };
  form.onsubmit = (e) => { e.preventDefault(); ask(q.value.trim()); };
  q.focus();
}

// Keep the newest exchange in view, inside the conversation's own scroll area.
function scrollToEnd() {
  const s = app.querySelector("#scroll");
  if (s) s.scrollTo({ top: s.scrollHeight, behavior: "smooth" });
}

async function ask(question) {
  if (!question) return;
  const log = app.querySelector("#log");
  const q = app.querySelector("#q");
  const send = app.querySelector("#send");
  const err = app.querySelector("#err");
  err.textContent = "";
  const item = document.createElement("li");
  item.className = "ask-item";
  item.innerHTML = `<div class="ask-q">${esc(question)}</div>
    <div class="ask-a pending"><span class="muted">Looking in the FAQ… <span class="secs"></span></span></div>`;
  log.append(item);
  app.querySelector("#empty").hidden = true;
  scrollToEnd();
  q.value = "";
  q.style.height = "auto";
  send.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { item.querySelector(".secs").textContent = `${Math.round((Date.now() - t0) / 1000)}s`; }, 1000);
  const box = item.querySelector(".ask-a");
  try {
    const r = await fetch(FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.supabaseAnonKey },
      body: JSON.stringify({ code, device, session: visitId(), question, history: turns.slice(-2) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status}). Try again.`);
    turns.push({ q: question, a: data.answer });
    box.classList.remove("pending");
    box.innerHTML = `${format(data.answer)}
      ${data.entries?.length ? `<div class="ask-links"><span class="muted small">Read more:</span>
        <ul>${data.entries.map((e) => `<li><a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(String(e.title).replace(/`/g, ""))}</a>${e.kind === "page" ? ` <span class="muted small">(course page)</span>` : ""}</li>`).join("")}</ul></div>` : ""}
      ${data.id ? rateHtml() : ""}`;
    dressCode(box);
    if (data.id) wireRating(box, data.id);
  } catch (e) {
    box.classList.remove("pending");
    box.classList.add("failed");
    box.innerHTML = `<p class="error">${esc(errorText(e))}</p>`;
    q.value = question;
  } finally {
    clearInterval(tick);
    send.disabled = false;
    q.focus();
    scrollToEnd();
  }
}

function rateHtml() {
  return `<div class="ask-rate">
    <span class="muted small">Did this help?</span>
    <button type="button" class="small" data-r="1" aria-pressed="false" aria-label="Yes, this helped">👍</button>
    <button type="button" class="small" data-r="-1" aria-pressed="false" aria-label="No, this did not help">👎</button>
    <span class="muted small thanks" hidden>Thanks.</span>
    <form class="ask-miss" hidden>
      <label class="small">What were you looking for? (optional)
        <textarea name="f" rows="2" maxlength="1000"></textarea></label>
      <div class="btns"><button class="small primary">Send</button></div>
    </form></div>`;
}

function wireRating(box, id) {
  const rate = box.querySelector(".ask-rate");
  const thanks = rate.querySelector(".thanks");
  const miss = rate.querySelector(".ask-miss");
  rate.querySelectorAll("button[data-r]").forEach((b) => {
    b.onclick = async () => {
      const r = Number(b.dataset.r);
      rate.querySelectorAll("button[data-r]").forEach((x) => {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      miss.hidden = r !== -1;
      thanks.hidden = r === -1;
      if (r === -1) miss.querySelector("textarea").focus();
      await sb.rpc("faq_rate", { p_question: id, p_device: device, p_rating: r, p_feedback: null });
    };
  });
  miss.onsubmit = async (e) => {
    e.preventDefault();
    const f = miss.querySelector("textarea").value.trim();
    if (f) await sb.rpc("faq_rate", { p_question: id, p_device: device, p_rating: -1, p_feedback: f });
    miss.hidden = true;
    thanks.hidden = false;
  };
}
