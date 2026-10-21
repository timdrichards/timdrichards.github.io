// Student page: <site>/?code. No login. Can read one activity's prompt and submit; nothing else.

import { sb, configured, esc, store, deviceId, notConfiguredHtml, errorText } from "./common.js";

const app = document.getElementById("app");
const params = new URLSearchParams(location.search);
const code = (params.get("a") || location.search.slice(1).split("&")[0] || location.hash.slice(1) || "")
  .trim().toLowerCase().replace(/[^a-z0-9]/g, "");

let act = null;
let waitTimer = null;

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

async function load() {
  const { data, error } = await sb.rpc("get_activity", { p_code: code });
  if (error) { app.innerHTML = `<div class="panel"><p class="error">${esc(errorText(error))}</p></div>`; return; }
  if (!data) { showJoin(`No activity with code "${code}".`); return; }
  act = data;
  document.title = `${act.title} · Class Spaces`;
  render();
}

function render() {
  clearTimeout(waitTimer);
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
      ${FORMS[act.kind](c)}
      <p id="msg" class="msg" role="status" aria-live="polite"></p>
      <button class="primary big" id="send">Send</button>
      <p class="muted small">Anonymous. Only your teacher sees responses.</p>
    </form>`;
  const f = app.querySelector("#f");
  WIRE[act.kind]?.(f, c);
  const again = f.querySelector("#newname");
  if (again) again.onclick = () => { store.set(randomKey(), randomGroupName()); render(); };
  f.onsubmit = (e) => { e.preventDefault(); send(f, c); };
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
function randomName() {
  let n = store.get(randomKey());
  if (!n) { n = randomGroupName(); store.set(randomKey(), n); }
  return n;
}

function groupField(c) {
  const mode = c.group || "optional";
  if (mode === "off") return "";
  if (mode === "random") {
    const n = randomName();
    return `<div class="group-badge">
        <span class="muted small">Your group name</span>
        <strong>${esc(n)}</strong>
        <input type="hidden" name="group" value="${esc(n)}">
        <button type="button" id="newname" class="link small">New name</button>
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

const saved = () => store.get("cs.answer." + code);

const FORMS = {
  card: (c) => {
    const tags = c.tags || [];
    return `${tags.length ? `<fieldset class="chips"><legend>Tag${c.tag_required ? "" : " (optional)"}</legend>
        ${c.tag_required ? "" : `<label class="chip"><input type="radio" name="tag" value="" checked><span>None</span></label>`}
        ${tags.map((t) => `<label class="chip"><input type="radio" name="tag" value="${esc(t)}"><span>${esc(t)}</span></label>`).join("")}
      </fieldset>` : ""}
      <label>Your response<textarea name="text" rows="4" maxlength="${c.max_len || 280}" required></textarea></label>
      <div class="muted small count"><span id="len">0</span> / ${c.max_len || 280}</div>`;
  },
  poll: (c) => `<fieldset class="options"><legend class="sr">Choose one</legend>
    ${(c.options || []).map((o, i) => `<label class="opt"><input type="radio" name="choice" value="${i}" ${saved()?.choice === i ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}
    </fieldset>`,
  scale: (c) => `<fieldset class="scale"><legend class="sr">Choose 1 to 5</legend>
    <div class="scale-btns">${[1, 2, 3, 4, 5].map((v) => `<label class="sbtn"><input type="radio" name="value" value="${v}" ${saved()?.value === v ? "checked" : ""}><span>${v}</span></label>`).join("")}</div>
    ${c.low || c.high ? `<div class="scale-ends"><span>1 = ${esc(c.low)}</span><span>5 = ${esc(c.high)}</span></div>` : ""}
    </fieldset>`,
  sort: (c) => {
    const prev = saved()?.placements || [];
    return `<div class="sort-items">${(c.items || []).map((it, i) => `
      <fieldset class="sort-item"><legend>${esc(it)}</legend>
        <div class="seg-btns">${(c.buckets || []).map((b, j) => `<label class="segb s${j + 1}"><input type="radio" name="p${i}" value="${j}" ${prev[i] === j ? "checked" : ""}><span>${esc(b)}</span></label>`).join("")}</div>
      </fieldset>`).join("")}</div>`;
  },
};

const WIRE = {
  card: (f) => {
    const len = f.querySelector("#len");
    f.text.addEventListener("input", () => { len.textContent = f.text.value.length; });
  },
};

function readBody(f, c) {
  if (act.kind === "card") {
    const tag = f.querySelector('input[name="tag"]:checked')?.value || null;
    return { text: f.text.value, tag };
  }
  if (act.kind === "poll") {
    const v = f.querySelector('input[name="choice"]:checked');
    return v ? { choice: +v.value } : null;
  }
  if (act.kind === "scale") {
    const v = f.querySelector('input[name="value"]:checked');
    return v ? { value: +v.value } : null;
  }
  if (act.kind === "sort") {
    return {
      placements: (c.items || []).map((_, i) => {
        const v = f.querySelector(`input[name="p${i}"]:checked`);
        return v ? +v.value : null;
      }),
    };
  }
}

async function send(f, c) {
  const msg = f.querySelector("#msg");
  const btn = f.querySelector("#send");
  const body = readBody(f, c);
  msg.className = "msg";
  if (act.kind === "card" && c.tag_required && (c.tags || []).length && !body.tag) {
    msg.textContent = "Pick a tag first."; msg.classList.add("error"); return;
  }
  if (!body) { msg.textContent = "Pick an answer first."; msg.classList.add("error"); return; }
  if (act.kind === "card" && !body.text.trim()) { msg.textContent = "Write something first."; msg.classList.add("error"); return; }
  const group = f.group ? f.group.value.trim() : "";
  if (c.group === "required" && !group) { msg.textContent = "Add your group name first."; msg.classList.add("error"); return; }
  if (f.group && c.group !== "random") store.set("cs.group", group);
  btn.disabled = true;
  const { data, error } = await sb.rpc("submit_response", {
    p_code: code, p_body: body, p_group: group || null, p_device: deviceId(),
  });
  btn.disabled = false;
  if (error) {
    msg.textContent = errorText(error);
    msg.classList.add("error");
    if (/closed/i.test(error.message)) { act.is_open = false; setTimeout(render, 1500); }
    return;
  }
  msg.classList.add("ok");
  if (act.kind === "card") {
    const left = data.limit - data.used;
    msg.textContent = left > 0 ? `Sent. You can add ${left} more.` : "Sent. That was your last one.";
    f.text.value = "";
    f.querySelector("#len").textContent = "0";
    if (left <= 0) btn.disabled = true;
  } else {
    store.set("cs.answer." + code, body);
    msg.textContent = data.replaced ? "Updated. You can change it again." : "Sent. You can change your answer.";
    btn.textContent = "Update";
  }
}
