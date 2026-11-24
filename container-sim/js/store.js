// store.js: saving work in this browser, and the export file that is both the backup
// and what students submit. The world is never stored: it is rebuilt by replaying each
// activity's log through the engine, which gives exactly the same result every time.

export const APP = "426-container-sim";
export const APP_VERSION = "0.1.0";
const KEY = "container-sim:v1";
// Built into the app: makes a hand-edited file show up as edited. It is not a secret,
// and the design says so; the vivas are the real check.
const CHECKSUM_SALT = "426-container-sim-v1";

const empty = () => ({ student: { name: "", email: "" }, current: null, activities: {}, lastExport: null });

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty(); // private window or blocked storage: work still runs, it just won't be kept
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function activityState(state, id) {
  state.activities[id] = state.activities[id] || { log: [], predictions: [], hintsUsed: 0, attempts: 0, reached: false, goals: {} };
  return state.activities[id];
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The payload the checksum covers: everything in the file except the checksum itself.
export function exportPayload(state, activities, engineVersion, now) {
  return {
    app: APP,
    appVersion: APP_VERSION,
    engineVersion,
    exportedAt: now,
    student: state.student,
    activities: Object.entries(state.activities).map(([id, a]) => ({
      id,
      activityVersion: (activities.find((x) => x.id === id) || {}).version ?? null,
      reached: a.reached,
      goals: Object.entries(a.goals).map(([gid, passed]) => ({ id: gid, passed })),
      predictions: a.predictions,
      hintsUsed: a.hintsUsed,
      attempts: a.attempts,
      log: a.log,
    })),
  };
}

export async function checksum(payload) {
  return sha256(JSON.stringify(payload) + CHECKSUM_SALT);
}

export async function makeExport(state, activities, engineVersion, now) {
  const payload = exportPayload(state, activities, engineVersion, now);
  return { ...payload, checksum: await checksum(payload) };
}

// Read an exported file back. Returns { state, edited } where edited means the checksum failed.
export async function readExport(text) {
  const file = JSON.parse(text);
  if (file.app !== APP) throw new Error("This is not a container simulator file.");
  const { checksum: sum, ...payload } = file;
  const edited = (await checksum(payload)) !== sum;
  const state = empty();
  state.student = file.student || state.student;
  for (const a of file.activities || []) {
    state.activities[a.id] = {
      log: a.log || [], predictions: a.predictions || [], hintsUsed: a.hintsUsed || 0, attempts: a.attempts || 0,
      reached: !!a.reached, goals: Object.fromEntries((a.goals || []).map((g) => [g.id, g.passed])),
    };
  }
  state.current = file.activities?.[0]?.id ?? null;
  return { state, edited };
}
