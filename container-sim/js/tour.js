// tour.js: a short guided tour of the screen, shown the first time someone visits.
// Each step points at one part of the page with a tooltip; Back, Next and Skip, and Esc
// to close. "Take the tour" in the bar shows it again.

const SEEN = "container-sim:toured";

const STEPS = [
  { target: ".sim-head h1", title: "Welcome", text: "This simulator shows what Docker and Docker Compose do while you type the commands from the course. Nothing here runs real Docker, so you can't break anything. This tour takes about a minute." },
  { target: "#activity", title: "1. Pick an activity", text: "Each activity is one short task from a unit. Start with the first one. Your progress on each is kept separately." },
  { target: "#goals", title: "2. Your goals", text: "What the activity asks you to do. Each goal ticks off by itself when the simulator sees it done." },
  { target: "#suggested", title: "3. Commands to try", text: "The commands this activity needs. Click one to put it in the terminal, read it, then press Enter to run it." },
  { target: "#term-form", title: "4. The terminal", text: "Type or paste commands here and press Enter. The output scrolls in above, as it would on your own machine. Up arrow brings back earlier commands." },
  { target: "#world", title: "5. What is running", text: "A picture of your laptop right now: images, containers, networks, ports and volumes. Watch it change after each command; this is the part real Docker never shows you." },
  { target: "#world-key", title: "6. Reading the picture", text: "What the colours and shapes mean. A blue box is a running container; dashed amber means it is still starting." },
  { target: "#events", title: "7. What just happened", text: "The last command's effects in plain words, step by step. Read this when the picture changes and you're not sure why." },
  { target: "#file-tabs", title: "8. Your files", text: "The repo's files: the Dockerfile, the Compose file, .env. Edit them here; build or run again to use your change. Problems are pointed out below the editor." },
  { target: "#hint-btn", title: "9. Stuck?", text: "Hints, one at a time. Using one is fine; it's recorded, not counted against you." },
  { target: "#export", title: "10. Save and submit", text: "Your work is saved in this browser as you go. Export it to keep a copy, to move to another computer, or to submit the file in Canvas." },
];

let i = 0, box, shade, current;

function place() {
  const step = STEPS[i];
  const el = document.querySelector(step.target);
  if (current) current.classList.remove("tour-target");
  current = el;
  if (!el) return next();
  el.classList.add("tour-target");
  el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  box.querySelector(".tour-title").textContent = step.title;
  box.querySelector(".tour-text").textContent = step.text;
  box.querySelector(".tour-count").textContent = `${i + 1} of ${STEPS.length}`;
  box.querySelector(".tour-back").disabled = i === 0;
  box.querySelector(".tour-next").textContent = i === STEPS.length - 1 ? "Start" : "Next";
  // Below the target if there's room, else above; kept inside the window.
  setTimeout(() => {
    const r = el.getBoundingClientRect(), bw = Math.min(360, window.innerWidth - 24);
    box.style.width = `${bw}px`;
    const bh = box.offsetHeight;
    const below = r.bottom + 14 + bh < window.innerHeight;
    const top = below ? r.bottom + 14 : Math.max(12, r.top - bh - 14);
    const left = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 12);
    box.style.top = `${top + window.scrollY}px`;
    box.style.left = `${left + window.scrollX}px`;
    box.dataset.side = below ? "below" : "above";
    box.style.setProperty("--arrow", `${Math.min(Math.max(16, r.left + r.width / 2 - left), bw - 16)}px`);
    box.querySelector(".tour-next").focus();
  }, 350);
}

function next() { if (i < STEPS.length - 1) { i++; place(); } else end(); }
function back() { if (i > 0) { i--; place(); } }

function end() {
  if (current) current.classList.remove("tour-target");
  box?.remove(); shade?.remove();
  box = shade = current = null;
  document.removeEventListener("keydown", keys);
  try { localStorage.setItem(SEEN, "1"); } catch { /* storage blocked: the tour shows again next time */ }
  document.getElementById("term-in")?.focus({ preventScroll: true });
}

function keys(e) {
  if (e.key === "Escape") end();
  if (e.key === "ArrowRight") next();
  if (e.key === "ArrowLeft") back();
}

export function startTour() {
  if (box) return;
  i = 0;
  shade = document.createElement("div");
  shade.className = "tour-shade";
  box = document.createElement("div");
  box.className = "tour";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-live", "polite");
  box.setAttribute("aria-label", "Tour of the simulator");
  box.innerHTML = `<p class="tour-count"></p><h2 class="tour-title"></h2><p class="tour-text"></p>
    <div class="tour-buttons"><button type="button" class="quiet tour-skip">Skip the tour</button>
    <span><button type="button" class="quiet tour-back">Back</button> <button type="button" class="tour-next">Next</button></span></div>`;
  document.body.append(shade, box);
  box.querySelector(".tour-next").onclick = next;
  box.querySelector(".tour-back").onclick = back;
  box.querySelector(".tour-skip").onclick = end;
  shade.onclick = end;
  document.addEventListener("keydown", keys);
  place();
}

export function maybeTour() {
  let seen = false;
  try { seen = localStorage.getItem(SEEN) === "1"; } catch { /* ignore */ }
  if (!seen) setTimeout(startTour, 500);
}
