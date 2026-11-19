// The Viva-only clipboard. Nothing can be copied out of Viva, and nothing from outside can be
// pasted in (unless the assessment allows pasting), but copy, cut and paste still work inside
// Viva: in the chat box, the code and math areas, the drawing pad's text, and the chat bubbles.
//
// How: on copy or cut, the selected text is kept here and the system clipboard gets only a short
// note. On paste, that note means "paste what Viva kept"; anything else came from outside.
// Dragging text and the right-click menu are turned off. This stops copying with the keyboard,
// the menus and drag and drop. It cannot stop a photo of the screen or retyping; the screenshots
// and the proctor cover those.

export const NOTE = "(Copied inside Viva. Copying out of Viva is turned off.)";

const editors = new Set();
let kept = "";

// An editor that is not a plain textarea (CodeMirror, MathLive) tells the guard how to read its
// selection and how to insert text. Returns a function that unregisters it.
export function registerEditor(el, { selectedText, replaceSelection }) {
  const e = { el, selectedText, replaceSelection };
  editors.add(e);
  return () => editors.delete(e);
}

const editorFor = (t) => [...editors].find((e) => e.el === t || e.el.contains(t));
const isField = (t) => t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && /^(text|search|email|url|)$/i.test(t.type)));

function selectedIn(t) {
  const e = editorFor(t);
  if (e) return e.selectedText() || "";
  if (isField(t)) return t.value.slice(t.selectionStart ?? 0, t.selectionEnd ?? 0);
  return String(window.getSelection?.() || "");
}

function insertInto(t, text) {
  const e = editorFor(t);
  if (e) { e.replaceSelection(text); return; }
  if (isField(t) && !t.readOnly && !t.disabled) {
    const room = t.maxLength > 0 ? t.maxLength - (t.value.length - ((t.selectionEnd ?? 0) - (t.selectionStart ?? 0))) : Infinity;
    t.setRangeText(text.slice(0, Math.max(0, room)), t.selectionStart ?? 0, t.selectionEnd ?? 0, "end");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

const stop = (ev) => { ev.preventDefault(); ev.stopImmediatePropagation(); };

// allowPaste(): whether pasting from outside is allowed now. onPaste(length): pasted from outside
// (allowed). onBlocked(length): a paste or drop from outside was blocked.
export function guard({ allowPaste = () => false, onPaste = () => {}, onBlocked = () => {} } = {}) {
  const copy = (ev) => {
    const t = ev.target;
    kept = selectedIn(t);
    ev.clipboardData?.setData("text/plain", NOTE);
    stop(ev);
    if (ev.type === "cut" && kept) insertInto(t, "");
  };
  const paste = (ev) => {
    const text = ev.clipboardData?.getData("text/plain") || "";
    if (text === NOTE) { stop(ev); insertInto(ev.target, kept); return; }
    if (allowPaste()) { onPaste(text.length); return; }
    stop(ev);
    onBlocked(text.length);
  };
  const drop = (ev) => {
    if (!ev.dataTransfer?.types?.length) return;
    const text = ev.dataTransfer.getData("text/plain") || "";
    if (allowPaste()) { onPaste(text.length); return; }
    stop(ev);
    if (text) onBlocked(text.length);
  };
  document.addEventListener("copy", copy, true);
  document.addEventListener("cut", copy, true);
  document.addEventListener("paste", paste, true);
  document.addEventListener("drop", drop, true);
  document.addEventListener("dragstart", stop, true);
  document.addEventListener("contextmenu", (ev) => ev.preventDefault(), true);
}
