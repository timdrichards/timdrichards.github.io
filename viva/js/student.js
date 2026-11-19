// Viva student page: join, share the entire screen, then a chat with the interviewer.
// Every request goes to the Edge Function `viva`; this page never reads the database.
//
// What it records, all sent to the server as it happens:
//   - each time the student leaves the page (window blur or tab hidden) and comes back, with
//     the length; the server answers with a notice that shows in the chat;
//   - screenshots of the shared screen: at the start, when the screen changes, at least once a
//     minute, and every few seconds while the student is away;
//   - blocked pastes, the screen share stopping, leaving full screen.
// Answers can be drawings (js/draw.js): the server may open a drawing area for an answer, with a
// starting diagram from the instructor, and the student can open a blank one with Draw. Each
// answer can carry how sure the student is (1-5), which the AIs never see. Answers can also be
// code (js/code.js, CodeMirror) or math (js/math.js, MathLive), in areas the server opens or the
// student opens with Code or Math; both load only when first needed. Copying out of the page is
// turned off, with a Viva-only clipboard inside it (js/guard.js).

import { Sketch } from "./draw.js";
import { guard, registerEditor } from "./guard.js";

const cfg = window.VIVA || {};
const FN_URL = cfg.functionUrl || `${String(cfg.supabaseUrl || "").replace(/\/$/, "")}/functions/v1/viva`;
const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);

const KEEP_MIN_MS = 60 * 1000;   // a screenshot at least this often, even if nothing changed
const CHANGE_MIN_MS = 4000;      // and no more often than this for changes
const CHANGE_THRESHOLD = 6;      // mean grey-level difference (0..255) on a 64x36 thumbnail
const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.6;

const state = {
  token: null, info: null, active: false, waiting: false,
  deadline: 0, skew: 0,
  stream: null, track: null, video: null, grabber: null,
  away: false, awayAt: 0, captureTimer: null, lastShot: 0, lastThumb: null, queue: [], uploading: false,
  firstKeyAt: 0, pasted: 0,
  pad: null, diagram: null, confidence: 0,
  work: null,   // the open code or math area: {area, kind, editor, starter, resets, requested, unregister}
};

const loadCode = () => import("./code.js");
const loadMath = () => import("./math.js");

// Before the chat starts (the join form) pasting is fine; during it, only what the assessment allows.
guard({
  allowPaste: () => !state.active || !!state.info?.allow_paste,
  onPaste: (length) => { state.pasted += length; },
  onBlocked: (length) => {
    if (!state.active) return;
    call("focus", { event: "paste_blocked", detail: { length } }).then((o) => o.notice && addMsg("notice", o.notice)).catch(() => {});
  },
});

// ---------------------------------------------------------------- server

async function call(action, body = {}) {
  const r = await fetch(FN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...(state.token ? { "x-viva-token": state.token } : {}) },
    body: JSON.stringify({ action, ...body }),
    keepalive: action === "focus",
  });
  let out = {};
  try { out = await r.json(); } catch { /* empty */ }
  if (!r.ok) {
    const err = new Error(out.error || `The server said ${r.status}.`);
    err.reason = out.reason;
    throw err;
  }
  return out;
}

function saved() {
  try { return JSON.parse(sessionStorage.getItem("viva.join") || "null"); } catch { return null; }
}
function save(v) {
  try { v ? sessionStorage.setItem("viva.join", JSON.stringify(v)) : sessionStorage.removeItem("viva.join"); } catch { /* fine */ }
}

// ---------------------------------------------------------------- join

async function join(code, email) {
  $("join-error").textContent = "";
  $("join-btn").disabled = true;
  try {
    const out = await call("join", { code, email });
    state.token = out.token;
    state.info = out;
    state.deadline = Date.parse(out.deadline_at);
    if (out.server_now) state.skew = Date.parse(out.server_now) - Date.now();
    save({ code, email });
    show("join", false);
    openGate();
  } catch (e) {
    $("join-error").textContent = e.message;
    if (["finished"].includes(e.reason)) save(null);
  } finally {
    $("join-btn").disabled = false;
  }
}

$("join-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  join($("code").value.trim().toUpperCase(), $("email").value.trim());
});

// ---------------------------------------------------------------- the gate: rules and screen share

function canShare() {
  return Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
}

function openGate() {
  const i = state.info;
  $("gate-title").textContent = i.title;
  const mins = Math.max(0, Math.round((state.deadline - now()) / 60000));
  $("gate-time").textContent = i.rejoined ? `about ${mins} minutes left` : `${mins} minutes`;
  show("gate-screen", i.require_screen);
  show("gate-paste", !i.allow_paste);
  show("gate-draw", !!i.allow_drawing);
  show("gate-code", !!i.allow_code);
  show("gate-math", !!i.allow_math);
  show("gate-conf", !!i.ask_confidence);
  show("gate-hint", i.hint_limit > 0);
  $("gate-hints").textContent = `${i.hint_limit} hint${i.hint_limit === 1 ? "" : "s"}`;
  $("share-btn").textContent = i.require_screen ? "Share my screen and start" : "Start";
  if (i.require_screen && !canShare()) {
    $("gate-error").textContent = "This browser cannot share your screen. Use a laptop with Chrome, Edge or Firefox.";
    $("share-btn").disabled = true;
  }
  show("gate");
}

async function shareScreen() {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "monitor", frameRate: 2 },
    audio: false,
    monitorTypeSurfaces: "include",
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  });
  const track = stream.getVideoTracks()[0];
  const surface = track.getSettings?.().displaySurface;
  if (surface && surface !== "monitor") {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Please choose Entire Screen, not a window or a tab.");
  }
  state.stream = stream;
  state.track = track;
  state.grabber = typeof ImageCapture === "function" ? new ImageCapture(track) : null;
  const v = state.video || document.createElement("video");
  v.muted = true; v.playsInline = true; v.srcObject = stream;
  await v.play().catch(() => {});
  state.video = v;
  track.addEventListener("ended", onScreenEnded);
  call("focus", { event: "screen_started", detail: { surface: surface || "" } }).catch(() => {});
  return surface;
}

$("share-btn").addEventListener("click", async () => {
  $("gate-error").textContent = "";
  $("share-btn").disabled = true;
  try {
    if (state.info.require_screen) await shareScreen();
    goFullscreen();
    startChat();
  } catch (e) {
    $("gate-error").textContent = e.name === "NotAllowedError"
      ? "Screen sharing was not allowed. Click the button again and choose Entire Screen. On a Mac, you may need to allow your browser in System Settings > Privacy & Security > Screen Recording."
      : e.message;
  } finally {
    $("share-btn").disabled = false;
  }
});

function goFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen().catch(() => {});
}

document.addEventListener("fullscreenchange", () => {
  if (!state.active) return;
  if (!document.fullscreenElement) {
    show("fs-banner");
    call("focus", { event: "fullscreen_exit" }).then((o) => o.notice && addMsg("notice", o.notice)).catch(() => {});
  } else {
    show("fs-banner", false);
  }
});
$("fs-btn").addEventListener("click", goFullscreen);

// ---------------------------------------------------------------- chat

function now() { return Date.now() + state.skew; }

function addMsg(role, text, meta = {}) {
  const d = document.createElement("div");
  d.className = `msg ${role}`;
  d.textContent = role === "helper" ? `Hint: ${text}` : text;
  if (meta.scene) {
    const v = document.createElement("span");
    v.className = "sketch-view";
    v.innerHTML = Sketch.svg(meta.scene);
    d.appendChild(v);
  }
  if (meta.code?.text) {
    const box = document.createElement("div");
    box.className = "work code";
    d.appendChild(box);
    loadCode().then(({ CodeBox }) => new CodeBox(box, { language: meta.code.language, text: meta.code.text, readOnly: true, label: "Your code" })).catch(() => { box.textContent = meta.code.text; });
  }
  if (meta.math?.latex) {
    const box = document.createElement("div");
    box.className = "work math";
    d.appendChild(box);
    loadMath().then(({ mathHTML }) => { box.innerHTML = mathHTML(meta.math.latex); }).catch(() => { box.textContent = meta.math.latex; });
  }
  if (meta.diagram) {
    const a = document.createElement("span");
    a.className = "asked";
    const what = { code: "Code area", math: "Math area" }[meta.diagram.kind] || "Drawing area";
    a.textContent = `${what} opened below: ${meta.diagram.title}`;
    d.appendChild(a);
  }
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
  return d;
}

function startChat() {
  show("gate", false);
  show("chat");
  $("chat-title").textContent = state.info.title;
  show("rec", !!state.stream);
  $("log").innerHTML = "";
  if (state.info.intro) {
    const d = addMsg("intro", state.info.intro);
    d.className = "intro";
  }
  for (const m of state.info.messages) addMsg(m.role, m.content, m.meta || {});
  show("draw-btn", !!state.info.allow_drawing);
  show("code-btn", !!state.info.allow_code);
  show("math-btn", !!state.info.allow_math);
  show("confidence", !!state.info.ask_confidence);
  state.hintsLeft = Math.max(0, (state.info.hint_limit || 0) - (state.info.hints_used || 0));
  showHints();
  const said = state.info.messages.filter((m) => m.role !== "notice" && m.role !== "helper");
  const last = said.at(-1);
  if (last?.role === "interviewer" && last.meta?.diagram) openArea(last.meta.diagram, true);
  state.active = true;
  tick();
  state.clock = setInterval(tick, 1000);
  if (state.stream) {
    shoot("start");
    state.captureTimer = setInterval(captureTick, Math.max(2, state.info.capture_every_sec) * 1000);
  }
  $("answer").focus();
}

function tick() {
  const left = Math.max(0, state.deadline - now());
  const m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
  $("timer").textContent = `${m}:${String(s).padStart(2, "0")}`;
  $("timer").classList.toggle("low", left < 2 * 60000);
  if (left <= 0 && state.active && !state.waiting) end("time");
}

$("answer").addEventListener("keydown", (ev) => {
  if (!state.firstKeyAt) state.firstKeyAt = performance.now();
  if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    $("compose").requestSubmit();
  }
});


// ---------------------------------------------------------------- drawing

function openDrawing(diagram, requested) {
  state.diagram = { ...diagram, requested };
  $("draw-title").textContent = diagram.title || "Drawing";
  $("draw-prompt").textContent = diagram.prompt || "";
  show("draw-close", !requested);
  show("draw-panel");
  $("chat").classList.add("drawing");
  state.pad = new Sketch($("pad"), { scene: diagram.scene || { items: [] }, stencils: state.info.stencils || [] });
  setAreaButtons();
  $("log").scrollTop = $("log").scrollHeight;
}

function closeDrawing() {
  state.pad = null; state.diagram = null;
  $("pad").innerHTML = "";
  show("draw-panel", false);
  $("chat").classList.remove("drawing");
  setAreaButtons();
}

$("draw-btn").addEventListener("click", () => {
  if (!state.pad) openDrawing({ id: "free", title: "Your drawing", prompt: "Draw, then press Send. You can add words in the box too.", scene: null }, false);
});
$("draw-close").addEventListener("click", () => {
  if (state.pad?.hasWork() && !confirm("Close the drawing? What you drew will be lost.")) return;
  closeDrawing();
});

// ---------------------------------------------------------------- code and math

// One answer area at a time: a drawing, code or math.
function setAreaButtons() {
  const busy = !!state.pad || !!state.work;
  for (const b of ["draw-btn", "code-btn", "math-btn"]) $(b).disabled = busy;
}

function openArea(area, requested) {
  if (state.pad) closeDrawing();
  if (state.work) closeWork();
  if (area.kind === "code" || area.kind === "math") return openWork(area, requested);
  openDrawing(area, requested);
}

// What the student has written in an area survives a reload of this tab.
const draftKey = (area) => `viva.draft.${state.info?.attempt_id}.${area.id}`;
function readDraft(area) {
  try { return JSON.parse(sessionStorage.getItem(draftKey(area)) || "null"); } catch { return null; }
}
function saveDraft() {
  const w = state.work;
  if (!w) return;
  try { sessionStorage.setItem(draftKey(w.area), JSON.stringify({ text: workValue(), resets: w.resets })); } catch { /* fine */ }
}
function clearDraft(area) {
  try { sessionStorage.removeItem(draftKey(area)); } catch { /* fine */ }
}

function workValue() {
  const w = state.work;
  if (!w?.editor) return "";
  return w.kind === "code" ? w.editor.text() : w.editor.value;
}

async function openWork(area, requested) {
  const draft = readDraft(area);
  const starter = String(area.starter || "");
  const w = { area, kind: area.kind, editor: null, starter, resets: draft?.resets || 0, requested };
  state.work = w;
  $("work-title").textContent = area.title || (area.kind === "code" ? "Code" : "Math");
  $("work-prompt").textContent = area.prompt || "";
  $("work-lang").textContent = area.kind === "code" ? (area.language || "") : "";
  show("work-reset", !!starter);
  show("work-close", !requested);
  $("work-box").innerHTML = "";
  show("work-panel");
  $("chat").classList.add("drawing");
  setAreaButtons();
  const typed = () => { if (!state.firstKeyAt) state.firstKeyAt = performance.now(); saveDraft(); };
  try {
    if (area.kind === "code") {
      const { CodeBox } = await loadCode();
      if (state.work !== w) return;
      w.editor = new CodeBox($("work-box"), { language: area.language, text: draft ? draft.text : starter, onChange: typed, label: area.title || "Code" });
      w.unregister = registerEditor(w.editor.view.dom, { selectedText: () => w.editor.selectedText(), replaceSelection: (t) => w.editor.replaceSelection(t) });
    } else {
      const { mathField, mathEditor } = await loadMath();
      if (state.work !== w) return;
      w.editor = mathField($("work-box"), { latex: draft ? draft.text : starter, onChange: typed, label: area.title || "Math" });
      w.unregister = registerEditor(w.editor, mathEditor(w.editor));
    }
    w.editor.focus?.();
  } catch (e) {
    $("chat-error").textContent = "The answer area could not load. Reload the page; your place is kept.";
  }
  $("log").scrollTop = $("log").scrollHeight;
}

function closeWork() {
  const w = state.work;
  if (!w) return;
  w.unregister?.();
  if (w.kind === "code") w.editor?.destroy();
  state.work = null;
  $("work-box").innerHTML = "";
  show("work-panel", false);
  $("chat").classList.remove("drawing");
  setAreaButtons();
}

$("work-reset").addEventListener("click", () => {
  const w = state.work;
  if (!w?.editor) return;
  if (!confirm(`Start over with the starting ${w.kind}? Your changes will be lost.`)) return;
  if (w.kind === "code") w.editor.setText(w.starter); else w.editor.value = w.starter;
  w.resets++;
  saveDraft();
  w.editor.focus?.();
});
$("work-close").addEventListener("click", () => {
  const w = state.work;
  if (w && workValue().trim() && workValue() !== w.starter && !confirm("Close this area? What you wrote will be lost.")) return;
  if (w) clearDraft(w.area);
  closeWork();
});
$("code-btn").addEventListener("click", () => {
  if (!state.pad && !state.work) openWork({ id: "free_code", kind: "code", title: "Your code", prompt: "Write your code, then press Send. You can add words in the box too.", language: state.info.code_language || "", starter: "" }, false);
});
$("math-btn").addEventListener("click", () => {
  if (!state.pad && !state.work) openWork({ id: "free_math", kind: "math", title: "Your math", prompt: "Write your math, then press Send. You can add words in the box too.", starter: "" }, false);
});

// ---------------------------------------------------------------- confidence

$("confidence").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-conf]");
  if (!b) return;
  state.confidence = +b.dataset.conf;
  $("confidence").querySelectorAll("[data-conf]").forEach((x) => {
    x.classList.toggle("on", x === b);
    x.setAttribute("aria-checked", String(x === b));
  });
  $("chat-error").textContent = "";
});
function resetConfidence() {
  state.confidence = 0;
  $("confidence").querySelectorAll("[data-conf]").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-checked", "false"); });
}

$("compose").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const text = $("answer").value.trim();
  if (state.waiting || !state.active) return;
  const drew = !!state.pad?.hasWork();
  const w = state.work;
  const wrote = w?.editor ? workValue() : "";
  if (!text && !drew && !wrote.trim()) {
    if (state.pad) $("chat-error").textContent = "Draw your answer (or type it) before sending.";
    if (w) $("chat-error").textContent = `Write your answer in the ${w.kind} area (or type it) before sending.`;
    return;
  }
  if (state.info.ask_confidence && !state.confidence) { $("chat-error").textContent = "Choose how sure you are (1 to 5) before sending."; return; }
  $("chat-error").textContent = "";
  state.waiting = true; $("hint-btn").disabled = true;
  $("send-btn").disabled = true;
  let drawing = null;
  try {
    if (drew) drawing = { scene: state.pad.scene(), png: await state.pad.png(), diagram: state.diagram?.id || "free" };
  } catch (e) {
    $("chat-error").textContent = e.message;
    state.waiting = false; $("send-btn").disabled = false;
    return;
  }
  const code = w?.kind === "code" && wrote.trim() ? { area: w.area.id, text: wrote, resets: w.resets } : null;
  const math = w?.kind === "math" && wrote.trim() ? { area: w.area.id, latex: wrote, resets: w.resets } : null;
  const mine = addMsg("student", text, { ...(drawing ? { scene: drawing.scene } : {}), ...(code ? { code: { language: w.area.language, text: wrote } } : {}), ...(math ? { math: { latex: wrote } } : {}) });
  $("answer").value = "";
  const typing = addMsg("interviewer typing", "Thinking…");
  const typed_ms = state.firstKeyAt ? Math.round(performance.now() - state.firstKeyAt) : null;
  try {
    const out = await call("say", { text, typed_ms, pasted: state.pasted, confidence: state.confidence || null, drawing, code, math });
    typing.remove();
    if (state.pad) closeDrawing();
    if (w) { clearDraft(w.area); closeWork(); }
    addMsg("interviewer", out.reply, out.diagram ? { diagram: out.diagram } : {});
    state.firstKeyAt = 0; state.pasted = 0;
    resetConfidence();
    if (out.done) finished(out.reply);
    else if (out.diagram) openArea(out.diagram, true);
  } catch (e) {
    typing.remove();
    mine.remove();
    $("chat-error").textContent = e.message + " Your answer was kept; you can send it again.";
    $("answer").value = text;
    if (e.reason === "finished") finished();
  } finally {
    state.waiting = false; showHints();
    $("send-btn").disabled = false;
    if (state.active) $("answer").focus();
  }
});

$("done-btn").addEventListener("click", () => {
  if (confirm("End the conversation now? You cannot come back to it.")) end("student");
});

async function end(reason) {
  if (!state.active) return;
  state.active = false;
  try {
    const out = await call("finish", { reason });
    finished(out.message);
  } catch (e) {
    finished();
  }
}

// ---------------------------------------------------------------- hints
// "I'm stuck" asks the server to write a hint and hold it; the student sees what it would cost and
// decides. Only "Show the hint" uses it.

function showHints() {
  show("hint-btn", (state.info.hint_limit || 0) > 0);
  $("hint-btn").textContent = state.hintsLeft ? `I'm stuck (${state.hintsLeft} left)` : "No hints left";
  $("hint-btn").disabled = !state.hintsLeft || state.waiting;
}

$("hint-btn").addEventListener("click", async () => {
  if (!state.active || state.waiting || !state.hintsLeft) return;
  $("chat-error").textContent = "";
  $("hint-btn").disabled = true;
  $("hint-btn").textContent = "Finding a hint…";
  try {
    const out = await call("hint");
    const pts = (n) => `${n} point${n === 1 ? "" : "s"}`;
    $("hint-ask-text").textContent = out.cost > 0
      ? `This hint costs up to ${pts(out.cost)} (out of ${out.max_points} for the whole conversation) on the part you are working on. You have ${out.hints_left} hint${out.hints_left === 1 ? "" : "s"} left. Use it?`
      : `This hint costs no more points on the part you are working on, but it uses one of your ${out.hints_left} hints. Use it?`;
    show("hint-ask");
    $("hint-yes").focus();
  } catch (e) {
    $("chat-error").textContent = e.message;
    showHints();
  }
});
$("hint-yes").addEventListener("click", async () => {
  show("hint-ask", false);
  try {
    const out = await call("hint", { confirm: true });
    state.hintsLeft = out.hints_left;
    addMsg("helper", out.hint);
  } catch (e) { $("chat-error").textContent = e.message; }
  showHints();
  $("answer").focus();
});
$("hint-no").addEventListener("click", async () => {
  show("hint-ask", false);
  try { await call("hint", { cancel: true }); } catch {}
  showHints();
});

function finished(text) {
  state.active = false;
  show("hint-ask", false);
  clearInterval(state.clock);
  clearInterval(state.captureTimer);
  setTimeout(() => {
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    save(null);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    show("chat", false); show("lock", false);
    if (text) $("finished-text").textContent = text;
    show("finished");
  }, 1500);
}

window.addEventListener("beforeunload", (ev) => {
  if (state.active) { ev.preventDefault(); ev.returnValue = ""; }
});

// ---------------------------------------------------------------- leaving and coming back

function goneAway(via) {
  if (!state.active || state.away) return;
  if (!$("lock").classList.contains("hidden")) return;   // the share picker is open
  state.away = true;
  state.awayAt = performance.now();
  call("focus", { event: "left", detail: { via } }).catch(() => {});
  if (state.stream) setTimeout(() => state.away && shoot("left"), 1500);
}

async function cameBack(via) {
  if (!state.active || !state.away) return;
  state.away = false;
  const duration_ms = Math.round(performance.now() - state.awayAt);
  if (state.stream) shoot("returned");
  try {
    const out = await call("focus", { event: "returned", duration_ms, detail: { via } });
    if (out.notice) addMsg("notice", out.notice);
  } catch { /* the 'left' row is still on the server, closed when the attempt ends */ }
}

window.addEventListener("blur", () => goneAway("blur"));
window.addEventListener("focus", () => { if (document.visibilityState === "visible") cameBack("focus"); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") goneAway("hidden");
  else if (document.hasFocus()) cameBack("visible");
});

// ---------------------------------------------------------------- screenshots

function onScreenEnded() {
  if (!state.active) return;
  state.stream = null; state.track = null; state.grabber = null;
  show("rec", false);
  show("lock");
  call("focus", { event: "screen_ended" }).then((o) => o.notice && addMsg("notice", o.notice)).catch(() => {});
}

$("reshare-btn").addEventListener("click", async () => {
  $("lock-error").textContent = "";
  try {
    await shareScreen();
    show("lock", false);
    show("rec");
    shoot("start");
  } catch (e) {
    $("lock-error").textContent = e.name === "NotAllowedError" ? "Screen sharing was not allowed. Try again and choose Entire Screen." : e.message;
  }
});

async function frame() {
  if (state.grabber) {
    try { return await state.grabber.grabFrame(); } catch { /* fall back to the video element */ }
  }
  const v = state.video;
  if (!v || !v.videoWidth) return null;
  return v;
}

async function draw() {
  const src = await frame();
  if (!src) return null;
  const w0 = src.videoWidth || src.width, h0 = src.videoHeight || src.height;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, MAX_WIDTH / w0);
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * scale); c.height = Math.round(h0 * scale);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  const t = document.createElement("canvas");
  t.width = 64; t.height = 36;
  const tc = t.getContext("2d", { willReadFrequently: true });
  tc.drawImage(c, 0, 0, 64, 36);
  const px = tc.getImageData(0, 0, 64, 36).data;
  const thumb = new Uint8Array(64 * 36);
  for (let i = 0; i < thumb.length; i++) thumb[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
  return { canvas: c, thumb };
}

function difference(a, b) {
  if (!a || !b) return 255;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

async function captureTick() {
  if (!state.active || !state.stream) return;
  const t = Date.now();
  if (state.away) return shoot("away");
  const d = await draw();
  if (!d) return;
  if (difference(d.thumb, state.lastThumb) > CHANGE_THRESHOLD && t - state.lastShot >= CHANGE_MIN_MS) return send(d, "change");
  if (t - state.lastShot >= KEEP_MIN_MS) return send(d, "interval");
}

async function shoot(reason) {
  const d = await draw();
  if (d) send(d, reason);
}

function send(d, reason) {
  state.lastShot = Date.now();
  state.lastThumb = d.thumb;
  const takenAt = now();
  d.canvas.toBlob((blob) => {
    if (!blob) return;
    if (state.queue.length > 30) state.queue.shift();
    state.queue.push({ blob, reason, takenAt, tries: 0 });
    pump();
  }, "image/jpeg", JPEG_QUALITY);
}

async function pump() {
  if (state.uploading) return;
  state.uploading = true;
  while (state.queue.length) {
    const item = state.queue[0];
    try {
      const r = await fetch(`${FN_URL}?action=capture`, {
        method: "POST",
        headers: { "content-type": "image/jpeg", "x-viva-token": state.token, "x-viva-reason": item.reason, "x-viva-taken-at": String(item.takenAt) },
        body: item.blob,
      });
      if (!r.ok && r.status >= 500 && ++item.tries < 3) { await new Promise((res) => setTimeout(res, 2000)); continue; }
      state.queue.shift();
    } catch {
      if (++item.tries >= 3) state.queue.shift();
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
  state.uploading = false;
}

// ---------------------------------------------------------------- start

const qs = location.search.replace(/^\?/, "").split("&")[0];
if (/^[A-Za-z0-9]{4,8}$/.test(qs)) $("code").value = qs.toUpperCase();
if (!cfg.supabaseUrl) {
  $("join-error").textContent = "Viva is not set up yet (js/config.js).";
  $("join-btn").disabled = true;
} else {
  const s = saved();
  if (s) { $("code").value = s.code; $("email").value = s.email; join(s.code, s.email); }
}
