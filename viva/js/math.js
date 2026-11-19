// Math areas: a MathLive math field. Students type math the way they would say it (x^2, /, sqrt,
// sum, alpha) and it is typeset as they go; on a tablet a math keyboard opens. The answer is kept
// as LaTeX, which the AIs read. Pinned in vendor/mathlive-<version>/ (private/vendor-build/build.sh).
// Loaded only by pages that need math, since it is about 800 KB.

import { MathfieldElement, convertLatexToMarkup } from "../vendor/mathlive-0.111.4/mathlive.min.mjs";

const BASE = new URL("../vendor/mathlive-0.111.4/", import.meta.url).href;
MathfieldElement.fontsDirectory = BASE + "fonts";
MathfieldElement.soundsDirectory = null;   // no keypress sounds in an exam room

// The stylesheet for typeset (read-only) math, added once.
function staticStyles() {
  if (document.getElementById("mathlive-static")) return;
  const l = document.createElement("link");
  l.id = "mathlive-static"; l.rel = "stylesheet"; l.href = BASE + "mathlive-static.css";
  document.head.appendChild(l);
}

// An editable math field in parent. Returns the element (value is the LaTeX).
export function mathField(parent, { latex = "", onChange = null, label = "Math answer" } = {}) {
  const mf = new MathfieldElement();
  mf.setAttribute("aria-label", label);
  mf.className = "mathbox";
  mf.mathVirtualKeyboardPolicy = "auto";
  parent.appendChild(mf);
  mf.value = latex;
  mf.menuItems = [];   // its own menu has copy items; the guard blocks the menu anyway
  if (onChange) mf.addEventListener("input", () => onChange());
  return mf;
}

// For the Viva-only clipboard (js/guard.js).
export const mathEditor = (mf) => ({
  selectedText: () => mf.getValue(mf.selection, "latex"),
  replaceSelection: (t) => { mf.insert(t, { format: "latex", insertionMode: "replaceSelection" }); mf.focus(); },
});

// Typeset LaTeX as HTML, for transcripts. Falls back to the LaTeX itself.
export function mathHTML(latex) {
  staticStyles();
  try { return convertLatexToMarkup(String(latex || "")); }
  catch { return String(latex || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
}
