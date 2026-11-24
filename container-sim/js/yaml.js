// yaml.js: the small part of YAML that Compose files in COMPSCI 426 use.
// Mappings and lists by indentation, "- item" lists (of scalars or of mappings),
// inline lists like [slow], quoted strings, # comments, numbers and booleans.
// Anchors, multi-line strings and flow mappings are not supported, and say so.

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(text) {
  const t = text.trim();
  if (t === "") return null;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    return inner ? splitFlow(inner).map(scalar) : [];
  }
  if (t.startsWith("{")) throw new Error(`flow mappings like ${t} are not supported here`);
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "|" || t === ">") throw new Error("multi-line strings are not supported here");
  return t;
}

function splitFlow(s) {
  const out = [];
  let cur = "", q = null, depth = 0;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

// The colon that ends a key: outside quotes, followed by a space or the end of the line.
function keyColon(text) {
  let q = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === ":" && (i === text.length - 1 || text[i + 1] === " ")) return i;
  }
  return -1;
}

export function parseYaml(src) {
  const lines = [];
  src.split("\n").forEach((raw, n) => {
    if (raw.includes("\t")) throw new Error(`line ${n + 1}: use spaces, not tabs, for indentation`);
    const line = stripComment(raw).replace(/\s+$/, "");
    if (line.trim() === "" || line.trim() === "---") return;
    lines.push({ indent: line.length - line.trimStart().length, text: line.trim(), n: n + 1 });
  });
  let i = 0;

  function block(indent) {
    if (i >= lines.length) return null;
    return lines[i].text.startsWith("- ") || lines[i].text === "-" ? list(lines[i].indent) : map(lines[i].indent);
  }

  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith("- ")) {
      const { text, n } = lines[i];
      const c = keyColon(text);
      if (c < 0) throw new Error(`line ${n}: expected "key: value"`);
      const key = scalar(text.slice(0, c));
      const rest = text.slice(c + 1).trim();
      i++;
      if (rest !== "") obj[key] = scalar(rest);
      else if (i < lines.length && lines[i].indent > indent) obj[key] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) obj[key] = list(indent);
      else obj[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return obj;
  }

  function list(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith("- ") || lines[i].text === "-")) {
      const { text } = lines[i];
      const item = text === "-" ? "" : text.slice(2).trim();
      const c = keyColon(item);
      if (c >= 0 && !item.startsWith('"') && !item.startsWith("'")) {
        // "- key: value" starts a mapping; later keys sit two spaces further in.
        lines[i] = { ...lines[i], indent: indent + 2, text: item };
        arr.push(map(indent + 2));
      } else {
        i++;
        arr.push(item === "" && i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : scalar(item));
      }
    }
    return arr;
  }

  const doc = block(0);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: unexpected indentation`);
  return doc;
}
