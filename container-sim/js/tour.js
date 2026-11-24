// tour.js: a short guided tour of the screen, shown the first time someone visits.
// Each step points at one part of the page with a tooltip; Back, Next and Skip, and Esc
// to close. "Take the tour" in the bar shows it again.

const SEEN = "container-sim:toured";

const STEPS = [
  { target: "#guide", title: "1. Follow the steps", text: "The activity, one step at a time. Each step says what to do, what to watch for, and afterwards what it meant. Click any step's title to go back to it." },
  { target: ".step.current .run, .step.current .step-body", title: "2. Run it", text: "Run it puts the step's command in the terminal and runs it. You can also type any command yourself." },
  { target: "#panel-picture", title: "3. Watch the picture", text: "Your laptop, drawn: images, containers, networks, ports and volumes. Anything a command adds glows and is tagged new, so you can see exactly what it did." },
  { target: "#console", title: "4. The terminal", text: "The output, as your own machine would print it. Skip (or Esc) shows long output at once." },
  { target: "#stage-tabs", title: "5. Files", text: "When a step asks you to edit the Dockerfile or the Compose file, the Files tab opens with checks that point out problems as you type." },
  { target: "#mywork-btn", title: "6. Save and submit", text: "Your work saves in this browser as you go. My work is where you export it to submit in Canvas, or import it on another computer." },
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
  box.querySelector(".tour-next").textContent = i === STEPS.length - 1 ? "Got it" : "Next";
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
