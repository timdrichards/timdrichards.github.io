// Read an assessment from JSON (a "Download for check" file, an example in private/check/examples,
// or one written by hand) into the values the assessment form holds. Plain module, no DOM, so it
// is tested in Node (private/test/import.test.mjs).

const TEXT = ["title", "course", "student_intro", "opening_question", "interviewer_brief", "answer_key", "transfer_settings"];
const BOOL = ["require_screen", "allow_paste", "allow_drawing", "ask_confidence"];
const NUM = {   // field: [min, max], as on the form
  time_limit_min: [1, 180], min_turns: [1, 50], max_turns: [1, 60], capture_every_sec: [2, 120],
  revisit_max: [0, 4], hint_limit: [0, 5],
};
// Keys a stored row or a download can carry that the form does not take from a file.
const SKIP = ["id", "created_at", "updated_at", "archived", "stencil_ids"];

// Returns { values, ignored, notes, resetShapes } or throws an Error with a message for the admin.
export function readAssessment(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error("That is not valid JSON: " + e.message); }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("Expected one assessment: a JSON object with a title, an opening question and a rubric.");
  const values = {}, ignored = [], notes = [];
  let resetShapes = false;
  for (const [k, v] of Object.entries(o)) {
    if (TEXT.includes(k)) {
      if (Array.isArray(v) && k === "transfer_settings") values[k] = v.map(String).join("\n");
      else if (typeof v === "string") values[k] = v;
      else if (v != null) throw new Error(`"${k}" should be text.`);
    } else if (BOOL.includes(k)) {
      if (typeof v !== "boolean") throw new Error(`"${k}" should be true or false.`);
      values[k] = v;
    } else if (k in NUM) {
      const n = Number(v), [lo, hi] = NUM[k];
      if (!Number.isFinite(n)) throw new Error(`"${k}" should be a number.`);
      const c = Math.min(hi, Math.max(lo, Math.round(n)));
      if (c !== n) notes.push(`${k} was ${v}; set to ${c} (allowed ${lo} to ${hi}).`);
      values[k] = c;
    } else if (k === "rubric") {
      if (!Array.isArray(v)) throw new Error('"rubric" should be a list of criteria.');
      values.rubric = v;
    } else if (k === "diagrams") {
      if (!Array.isArray(v)) throw new Error('"diagrams" should be a list.');
      values.diagrams = v.map((d, i) => {
        if (!d || typeof d !== "object") throw new Error(`Diagram ${i + 1} is not an object.`);
        return { id: typeof d.id === "string" && d.id ? d.id : `d${i + 1}`, title: String(d.title || ""), prompt: String(d.prompt || ""),
                 when: String(d.when || ""), scene: d.scene && typeof d.scene === "object" ? d.scene : null };
      });
    } else if (k === "stencil_ids" && v != null) {
      resetShapes = true;
      notes.push("The shapes offered are not taken from the file (they belong to one library); every shape is ticked.");
    } else if (!SKIP.includes(k)) {
      ignored.push(k);
    }
  }
  if (!values.title) notes.push("The file has no title.");
  if (!values.opening_question) notes.push("The file has no opening question.");
  if (!values.rubric) notes.push("The file has no rubric.");
  return { values, ignored, notes, resetShapes };
}
