// Code areas: a CodeMirror 6 editor with syntax highlighting for any language CodeMirror knows
// (about 100; each language's highlighter loads only when an area uses it). Used by the student
// page (answers), the admin assessment page (starter code) and the review page (read-only).
// The editor is the pinned bundle in vendor/codemirror-<version>/, built by
// private/vendor-build/build.sh; the site itself has no build step.

import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars,
  EditorState, Compartment, history, defaultKeymap, historyKeymap, indentWithTab,
  LanguageDescription, syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching,
  closeBrackets, closeBracketsKeymap, languages,
} from "../vendor/codemirror-6.0.2/codemirror.js";

// Every language name CodeMirror can highlight, for the admin's language box.
export const LANGUAGES = languages.map((l) => l.name).sort((a, b) => a.localeCompare(b));

// The known language for a name or file extension ("JavaScript", "js", "python"), or null.
export function findLanguage(name) {
  const n = String(name || "").trim();
  if (!n) return null;
  return LanguageDescription.matchLanguageName(languages, n, true)
    || languages.find((l) => l.extensions.includes(n.replace(/^\./, "").toLowerCase())) || null;
}

const theme = EditorView.theme({
  "&": { fontSize: "15px", border: "1px solid var(--border, #ccc)", borderRadius: "6px", background: "#fff" },
  "&.cm-focused": { outline: "2px solid var(--accent, #2563eb)", outlineOffset: "1px" },
  ".cm-content": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", minHeight: "8rem" },
  ".cm-gutters": { background: "#f6f6f6", borderRight: "1px solid #e5e5e5", color: "#888" },
  ".cm-scroller": { overflow: "auto", maxHeight: "50vh" },
});

export class CodeBox {
  // parent: the element to fill. language: a name for findLanguage. text: the starting code.
  // readOnly: for showing code. onChange(): after every edit. label: for screen readers.
  constructor(parent, { language = "", text = "", readOnly = false, onChange = null, label = "Code" } = {}) {
    this.lang = new Compartment();
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(), highlightSpecialChars(), drawSelection(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(), theme, this.lang.of([]),
          EditorView.contentAttributes.of({ spellcheck: "false", autocorrect: "off", autocapitalize: "off", "aria-label": label }),
          ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [
            history(), indentOnInput(), closeBrackets(), highlightActiveLine(), highlightActiveLineGutter(),
            keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
            EditorView.updateListener.of((u) => { if (u.docChanged && onChange) onChange(); }),
          ]),
        ],
      }),
    });
    this.view.dom.classList.add("codebox");
    const found = findLanguage(language);
    this.ready = found ? found.load().then((support) => this.view.dispatch({ effects: this.lang.reconfigure(support) })).catch(() => {}) : Promise.resolve();
  }
  text() { return this.view.state.doc.toString(); }
  setText(t) {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: String(t ?? "") }, selection: { anchor: 0 } });
  }
  // For the Viva-only clipboard (js/guard.js).
  selectedText() {
    const s = this.view.state;
    return s.selection.ranges.filter((r) => !r.empty).map((r) => s.sliceDoc(r.from, r.to)).join("\n");
  }
  replaceSelection(t) {
    if (this.view.state.readOnly) return;
    this.view.dispatch(this.view.state.replaceSelection(t));
    this.view.focus();
  }
  focus() { this.view.focus(); }
  destroy() { this.view.destroy(); }
}
