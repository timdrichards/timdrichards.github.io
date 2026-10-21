// Student page: <site>/?code. No login. Can read one activity's prompt and submit; nothing else,
// except two kinds that show posts on purpose: dot voting (the cards to vote on) and the
// question queue (questions and their votes), never with group names.

import { sb, configured, esc, store, deviceId, notConfiguredHtml, errorText } from "./common.js";

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const code = (params.get("a") || location.search.slice(1).split("&")[0] || location.hash.slice(1) || "")
  .trim().toLowerCase().replace(/[^a-z0-9]/g, "");

let act = null;
let waitTimer = null;
let liveTimer = null;

if (!configured) app.innerHTML = notConfiguredHtml();
else if (!code) showJoin();
else load();

function showJoin(msg = "") {
  app.innerHTML = `<div class="panel">
    <h1>Class Spaces</h1>
    <form id="join" class="stack-form">
      <label>Activity code<input name="code" autocomplete="off" autocapitalize="none" maxlength="12" required></label>
      ${msg ? `<p class="error">${esc(msg)}</p>` : ""}
      <button class="primary">Go</button>
    </form></div>`;
  app.querySelector("#join").onsubmit = (e) => {
    e.preventDefault();
    location.search = "?" + e.target.code.value.trim().toLowerCase();
  };
}

async function fetchActivity() {
  const { data, error } = await sb.rpc("get_activity", { p_code: code });
  if (error) throw error;
  return data;
}

async function load() {
  let data;
  try { data = await fetchActivity(); } catch (e) {
    app.innerHTML = `<div class="panel"><p class="error">${esc(errorText(e))}</p></div>`; return;
  }
  if (!data) { showJoin(`No activity with code "${code}".`); return; }
  act = data;
  document.title = `${act.title} · Class Spaces`;
  render();
}

const NOTE = {
  dots: "Anonymous. Cards show without names; only your teacher sees who voted for what.",
  qa: "Anonymous. Questions show to the class without names.",
};

function render() {
  clearTimeout(waitTimer);
  clearInterval(liveTimer);
  if (!act.is_open) {
    app.innerHTML = `${header()}<div class="panel closed"><p><strong>This activity is closed.</strong></p>
      <p class="muted">This page checks again every few seconds.</p></div>`;
    waitTimer = setTimeout(load, 5000);
    return;
  }
  const c = act.config || {};
  app.innerHTML = `${header()}
    <form id="f" class="panel stack-form" novalidate>
      ${groupField(c)}
      ${FORMS[act.kind] ? FORMS[act.kind](c) : `<p class="error">This page does not know this kind of activity yet. Reload the page.</p>`}
      <p id="msg" class="msg" role="status" aria-live="polite"></p>
      <button class="primary big" id="send">${act.kind === "qa" ? "Post question" : "Send"}</button>
      <p class="muted small">${NOTE[act.kind] || "Anonymous. Only your teacher sees responses."}</p>
    </form>
    ${act.kind === "qa" ? `<section class="panel"><h2 class="sub">Questions so far</h2><div id="qa-list" class="qa-list"><p class="muted">Loading…</p></div></section>` : ""}`;
  const f = app.querySelector("#f");
  WIRE[act.kind]?.(f, c);
  const again = f.querySelector("#newname");
  if (again) again.onclick = () => claimName(true);
  if ((c.group || "optional") === "random" && !claimed && !store.get(postedKey(), false)) claimName(false);
  f.onsubmit = (e) => { e.preventDefault(); send(f, c); };
  // Notice when the teacher closes the activity or starts round 2 of a vote.
  liveTimer = setInterval(watch, act.kind === "qa" ? 5000 : 4000);
}

async function watch() {
  if (act.kind === "qa") refreshQuestions();
  let data;
  try { data = await fetchActivity(); } catch { return; }
  if (!data) return;
  const roundChanged = act.kind === "vote" && (data.config?.round || 1) !== (act.config?.round || 1);
  if (!data.is_open || roundChanged) { act = data; render(); }
}

// Group label modes (activity config.group): "off", "optional", "required", or "random".
// Random: this device gets a name like "Teal Otter", kept for every activity in the same space,
// so a group that posts from one device shows up under one name all class.
const ADJ = ["Amber", "Brave", "Bright", "Calm", "Clever", "Coral", "Cosmic", "Crimson", "Golden", "Jade",
  "Lucky", "Lunar", "Mighty", "Misty", "Nimble", "Quiet", "Rapid", "Silver", "Sunny", "Swift", "Teal", "Witty"];
const NOUN = ["Badger", "Comet", "Falcon", "Fox", "Gecko", "Heron", "Koala", "Lynx", "Maple", "Meteor", "Otter",
  "Owl", "Panda", "Pebble", "Puffin", "Quokka", "Raven", "Robin", "Salmon", "Sparrow", "Tiger", "Walrus"];
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const randomGroupName = () => `${pick(ADJ)} ${pick(NOUN)}`;
const randomKey = () => "cs.rgroup." + (act.space || "");
const postedKey = () => "cs.rposted." + (act.space || "");
function randomName() {
  let n = store.get(randomKey());
  if (!n) { n = randomGroupName(); store.set(randomKey(), n); }
  return n;
}

// Ask the server for a name no other device in this space has (claim_group_name in schema.sql).
// If the function is not there yet, the locally picked name stands.
let claimed = false;
async function claimName(fresh) {
  claimed = true;
  const { data, error } = await sb.rpc("claim_group_name", { p_code: code, p_device: deviceId(), p_fresh: !!fresh });
  if (!error && typeof data === "string" && data) store.set(randomKey(), data);
  else if (fresh) store.set(randomKey(), randomGroupName());
  const badge = app.querySelector(".group-badge");
  if (!badge) return;
  const n = randomName();
  badge.querySelector("strong").textContent = n;
  badge.querySelector('input[name="group"]').value = n;
}

function groupField(c) {
  const mode = c.group || "optional";
  if (mode === "off") return "";
  if (mode === "random") {
    const n = randomName();
    // Once this device has posted under the name, keep it: no "New name" button.
    const locked = store.get(postedKey(), false);
    return `<div class="group-badge">
        <span class="muted small">Your group name</span>
        <strong>${esc(n)}</strong>
        <input type="hidden" name="group" value="${esc(n)}">
        ${locked ? "" : `<button type="button" id="newname" class="link small">New name</button>`}
      </div>
      <p class="muted small">Tell your group this name. Use the same device, so every post today is under it.</p>`;
  }
  const req = mode === "required";
  return `<label class="group">Group name${req ? "" : " (optional)"}<input name="group" maxlength="40" autocomplete="off" ${req ? "required" : ""} value="${esc(store.get("cs.group", ""))}"></label>`;
}

function header() {
  return `<header class="s-head"><div class="muted small">${esc(act.space)}</div>
    <h1>${esc(act.title)}</h1>${act.prompt ? `<p class="prompt">${esc(act.prompt)}</p>` : ""}</header>`;
}

// The saved answer for one-answer kinds (per round for votes), used to prefill the form.
const round = () => (act.config?.round === 2 ? 2 : 1);
const answerKey = () => "cs.answer." + code + (act.kind === "vote" ? ".r" + round() : "");
const saved = () => store.get(answerKey());

const scaleButtons = (c, value) => `<fieldset class="scale"><legend class="sr">Choose 1 to 5</legend>
    <div class="scale-btns">${[1, 2, 3, 4, 5].map((v) => `<label class="sbtn"><input type="radio" name="value" value="${v}" ${value === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div>
    ${c.low || c.high ? `<div class="scale-ends"><span>1 = ${esc(c.low)}</span><span>5 = ${esc(c.high)}</span></div>` : ""}
    </fieldset>`;

const textBox = (label, max, name = "text") => `<label>${esc(label)}<textarea name="${name}" rows="4" maxlength="${max}" required></textarea></label>
      <div class="muted small count"><span id="len">0</span> / ${max}</div>`;

const SURE = ["Guessing", "Fairly sure", "Sure"];

const FORMS = {
  card: (c) => {
    const tags = c.tags || [];
    return `${tags.length ? `<fieldset class="chips"><legend>Tag${c.tag_required ? "" : " (optional)"}</legend>
        ${c.tag_required ? "" : `<label class="chip"><input type="radio" name="tag" value="" checked><span>None</span></label>`}
        ${tags.map((t) => `<label class="chip"><input type="radio" name="tag" value="${esc(t)}"><span>${esc(t)}</span></label>`).join("")}
      </fieldset>` : ""}
      ${textBox("Your response", c.max_len || 280)}`;
  },
  poll: (c) => `<fieldset class="options"><legend class="sr">Choose one</legend>
    ${(c.options || []).map((o, i) => `<label class="opt"><input type="radio" name="choice" value="${i}" ${saved()?.choice === i ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}
    </fieldset>`,
  scale: (c) => scaleButtons(c, saved()?.value),
  sort: (c) => {
    const prev = saved()?.placements || [];
    return `<div class="sort-items">${(c.items || []).map((it, i) => `
      <fieldset class="sort-item"><legend>${esc(it)}</legend>
        <div class="seg-btns">${(c.buckets || []).map((b, j) => `<label class="segb s${j + 1}"><input type="radio" name="p${i}" value="${j}" ${prev[i] === j ? "checked" : ""}><span>${esc(b)}</span></label>`).join("")}</div>
      </fieldset>`).join("")}</div>`;
  },
  vote: (c) => {
    const s = saved();
    return `<p class="round-chip">Round ${round()}${round() === 2 ? ": vote again after your discussion" : ""}</p>
      <fieldset class="options"><legend class="sr">Choose one</legend>
      ${(c.options || []).map((o, i) => `<label class="opt"><input type="radio" name="choice" value="${i}" ${s?.choice === i ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}
      </fieldset>
      ${c.confidence !== false ? `<fieldset class="chips"><legend>How sure are you?</legend>
        ${SURE.map((t, k) => `<label class="chip"><input type="radio" name="confidence" value="${k + 1}" ${s?.confidence === k + 1 ? "checked" : ""}><span>${t}</span></label>`).join("")}
      </fieldset>` : ""}`;
  },
  dots: (c) => `<p><strong>You have <span id="dots-left">${c.votes || 3}</span> of ${c.votes || 3} votes left.</strong> Tap the cards you find most useful.</p>
    <div id="dots-list" class="dots-list"><p class="muted">Loading the cards…</p></div>
    <button type="button" class="link small" id="dots-refresh">Show new cards</button>`,
  slider: (c) => {
    const s = saved();
    return `<div class="slider-ask">
      <input type="range" name="value" min="0" max="100" step="1" value="${s?.value ?? 50}" aria-label="Where you stand" ${s ? 'data-touched="1"' : ""}>
      <div class="scale-ends"><span>${esc(c.low)}</span><span>${esc(c.high)}</span></div>
      <p class="muted small" id="slider-hint">${s ? "" : "Drag the slider to where you stand."}</p></div>`;
  },
  qa: (c) => textBox("Your question", c.max_len || 280),
  rank: (c) => {
    const items = c.items || [];
    const order = saved()?.order?.length === items.length ? saved().order : items.map((_, i) => i);
    return `<p class="muted small">Put the most important at the top. Use the arrows to move an item.</p>
      <ol class="rank-list" id="rank-list" data-order="${order.join(",")}"></ol>`;
  },
  quiz: () => `<label>Your answer<input name="answer" maxlength="200" autocomplete="off" autocapitalize="none" value="${esc(saved()?.answer ?? "")}"></label>`,
  hotspot: (c) => `<p class="muted small">Tap the picture${(c.points || 1) > 1 ? ` (up to ${c.points} times)` : ""}. Tap a dot again to remove it.</p>
    <div class="hot-wrap hot-pick" id="hot"><img src="${esc(c.image_url)}" alt="The picture for this activity" draggable="false"><div class="hot-layer"></div></div>`,
  ticket: (c) => `${scaleButtons(c, saved()?.value)}
    ${textBox(c.question || "Tell us more", c.max_len || 400)}`,
};

// Text is kept as a draft on this device until it is sent, so a closed activity
// or a reload never loses what a student typed.
const draftKey = () => "cs.draft." + code;
function wireText(f) {
  const len = f.querySelector("#len");
  const draft = store.get(draftKey(), "") || (act.kind === "ticket" ? saved()?.text || "" : "");
  if (draft) { f.text.value = draft; len.textContent = draft.length; }
  f.text.addEventListener("input", () => {
    len.textContent = f.text.value.length;
    store.set(draftKey(), f.text.value);
  });
}

let dotCards = [];
let hotPoints = [];

const WIRE = {
  card: wireText,
  ticket: wireText,
  qa: (f) => { wireText(f); refreshQuestions(); },
  dots: (f, c) => {
    f.querySelector("#dots-refresh").onclick = () => loadDots(f, c);
    loadDots(f, c);
  },
  slider: (f) => {
    const r = f.querySelector('input[name="value"]');
    r.addEventListener("input", () => { r.dataset.touched = "1"; f.querySelector("#slider-hint").textContent = ""; });
  },
  rank: (f, c) => {
    const list = f.querySelector("#rank-list");
    const items = c.items || [];
    const draw = () => {
      const order = list.dataset.order.split(",").map(Number);
      list.innerHTML = order.map((i, k) => `<li class="rank-item">
        <span class="rank-pos">${k + 1}</span><span class="rank-text">${esc(items[i])}</span>
        <button type="button" class="rank-btn" data-k="${k}" data-d="-1" ${k === 0 ? "disabled" : ""} aria-label="Move up">↑</button>
        <button type="button" class="rank-btn" data-k="${k}" data-d="1" ${k === order.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button>
      </li>`).join("");
      list.querySelectorAll(".rank-btn").forEach((b) => b.onclick = () => {
        const o = list.dataset.order.split(",").map(Number);
        const k = +b.dataset.k;
        const j = k + +b.dataset.d;
        [o[k], o[j]] = [o[j], o[k]];
        list.dataset.order = o.join(",");
        draw();
      });
    };
    draw();
  },
  hotspot: (f, c) => {
    const wrap = f.querySelector("#hot");
    const layer = wrap.querySelector(".hot-layer");
    hotPoints = (saved()?.points || []).slice();
    const draw = () => { layer.innerHTML = hotPoints.map((p) => `<i class="hot mine" style="left:${p.x * 100}%;top:${p.y * 100}%"></i>`).join(""); };
    wrap.addEventListener("click", (e) => {
      const box = wrap.querySelector("img").getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
      const near = hotPoints.findIndex((p) => Math.hypot((p.x - x) * box.width, (p.y - y) * box.height) < 24);
      if (near >= 0) hotPoints.splice(near, 1);
      else if (hotPoints.length < (c.points || 1)) hotPoints.push({ x: +x.toFixed(4), y: +y.toFixed(4) });
      else if ((c.points || 1) === 1) hotPoints = [{ x: +x.toFixed(4), y: +y.toFixed(4) }];
      draw();
    });
    draw();
  },
};

// Dot voting: show the source cards with a toggle each, at most `votes` picked.
async function loadDots(f, c) {
  const list = f.querySelector("#dots-list");
  const { data, error } = await sb.rpc("get_dot_cards", { p_code: code });
  if (error) { list.innerHTML = `<p class="error">${esc(errorText(error))}</p>`; return; }
  dotCards = data || [];
  const picked = new Set([...list.querySelectorAll("input:checked")].map((i) => i.value).concat(
    list.querySelector("input") ? [] : saved()?.picks || []));
  list.innerHTML = dotCards.length ? dotCards.map((k) => `
    <label class="dot-card"><input type="checkbox" name="pick" value="${esc(k.id)}" ${picked.has(k.id) ? "checked" : ""}>
      <span>${k.tag ? `<em>${esc(k.tag)}</em> ` : ""}${esc(k.text)}</span></label>`).join("")
    : `<p class="muted">No cards yet. Tap "Show new cards" in a moment.</p>`;
  const limit = c.votes || 3;
  const sync = () => {
    const n = list.querySelectorAll("input:checked").length;
    f.querySelector("#dots-left").textContent = Math.max(0, limit - n);
    list.querySelectorAll("input").forEach((i) => { i.disabled = !i.checked && n >= limit; });
  };
  list.querySelectorAll("input").forEach((i) => i.addEventListener("change", sync));
  sync();
}

// Question queue: the list with an upvote button each, refreshed every few seconds.
async function refreshQuestions() {
  const box = app.querySelector("#qa-list");
  if (!box) return;
  const { data, error } = await sb.rpc("get_questions", { p_code: code, p_device: deviceId() });
  if (error) { box.innerHTML = `<p class="error">${esc(errorText(error))}</p>`; return; }
  const qs = data || [];
  box.innerHTML = qs.length ? qs.map((q) => `<div class="qa-item">
      <button type="button" class="qa-vote ${q.voted ? "on" : ""}" data-id="${esc(q.id)}" ${q.voted ? "disabled" : ""} aria-label="Upvote">▲ ${q.votes}</button>
      <div class="qa-text">${esc(q.text)}</div></div>`).join("")
    : `<p class="muted">No questions yet. Be the first.</p>`;
  box.querySelectorAll(".qa-vote:not([disabled])").forEach((b) => b.onclick = async () => {
    b.disabled = true;
    const f = app.querySelector("#f");
    const group = f?.group ? f.group.value.trim() : "";
    const { error: e } = await sb.rpc("submit_response", {
      p_code: code, p_body: { upvote: b.dataset.id }, p_group: group || null, p_device: deviceId(),
    });
    if (e) { const m = app.querySelector("#msg"); if (m) { m.className = "msg error"; m.textContent = errorText(e); } }
    refreshQuestions();
  });
}

function readBody(f, c) {
  const checked = (name) => f.querySelector(`input[name="${name}"]:checked`);
  switch (act.kind) {
    case "card": return { text: f.text.value, tag: checked("tag")?.value || null };
    case "poll": return checked("choice") ? { choice: +checked("choice").value } : null;
    case "scale": return checked("value") ? { value: +checked("value").value } : null;
    case "sort":
      return {
        placements: (c.items || []).map((_, i) => { const v = checked("p" + i); return v ? +v.value : null; }),
      };
    case "vote": {
      if (!checked("choice")) return null;
      const body = { choice: +checked("choice").value };
      if (c.confidence !== false) {
        if (!checked("confidence")) return { missing: "Say how sure you are." };
        body.confidence = +checked("confidence").value;
      }
      return body;
    }
    case "dots": {
      const picks = [...f.querySelectorAll('input[name="pick"]:checked')].map((i) => i.value);
      return picks.length ? { picks } : { missing: "Tap at least one card." };
    }
    case "slider": {
      const r = f.querySelector('input[name="value"]');
      return r.dataset.touched ? { value: +r.value } : { missing: "Drag the slider to where you stand." };
    }
    case "qa": return { text: f.text.value };
    case "rank": return { order: f.querySelector("#rank-list").dataset.order.split(",").map(Number) };
    case "quiz": return f.answer.value.trim() ? { answer: f.answer.value } : { missing: "Write an answer first." };
    case "hotspot": return hotPoints.length ? { points: hotPoints } : { missing: "Tap the picture first." };
    case "ticket":
      if (!checked("value")) return null;
      return { value: +checked("value").value, text: f.text.value };
    default: return null;
  }
}

const MANY = ["card", "qa"];          // kinds where each send adds a new post
const TEXT = ["card", "qa", "ticket"]; // kinds with a text box that must not be empty

async function send(f, c) {
  const msg = f.querySelector("#msg");
  const btn = f.querySelector("#send");
  const body = readBody(f, c);
  const fail = (t) => { msg.className = "msg error"; msg.textContent = t; };
  msg.className = "msg";
  if (act.kind === "card" && c.tag_required && (c.tags || []).length && !body.tag) return fail("Pick a tag first.");
  if (!body) return fail("Pick an answer first.");
  if (body.missing) return fail(body.missing);
  if (TEXT.includes(act.kind) && !body.text.trim()) return fail("Write something first.");
  const group = f.group ? f.group.value.trim() : "";
  if (c.group === "required" && !group) return fail("Add your group name first.");
  if (f.group && c.group !== "random") store.set("cs.group", group);
  btn.disabled = true;
  const { data, error } = await sb.rpc("submit_response", {
    p_code: code, p_body: body, p_group: group || null, p_device: deviceId(),
  });
  btn.disabled = false;
  if (error) {
    fail(errorText(error));
    if (/closed/i.test(error.message)) { act.is_open = false; setTimeout(render, 1500); }
    return;
  }
  msg.classList.add("ok");
  if (c.group === "random" && !store.get(postedKey(), false)) {
    store.set(postedKey(), true);
    f.querySelector("#newname")?.remove();
  }
  if (TEXT.includes(act.kind)) store.set(draftKey(), "");
  if (MANY.includes(act.kind)) {
    const left = data.limit - data.used;
    const what = act.kind === "qa" ? "question" : "";
    msg.textContent = left > 0 ? `Sent. You can add ${left} more${what ? ` ${what}${left === 1 ? "" : "s"}` : ""}.` : "Sent. That was your last one.";
    f.text.value = "";
    f.querySelector("#len").textContent = "0";
    if (left <= 0) btn.disabled = true;
    if (act.kind === "qa") refreshQuestions();
    return;
  }
  store.set(answerKey(), body);
  if (act.kind === "quiz" && typeof data.correct === "boolean") {
    msg.className = "msg " + (data.correct ? "ok" : "error");
    msg.textContent = data.correct ? "Right! You can change your answer." : "Not quite. Try again if you like.";
  } else {
    msg.textContent = data.replaced ? "Updated. You can change it again." : "Sent. You can change your answer.";
  }
  btn.textContent = "Update";
}
