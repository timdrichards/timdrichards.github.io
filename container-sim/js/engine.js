// engine.js: the container simulator's model of Docker and Docker Compose.
//
// One plain object, the world, holds everything: the laptop (its files and ports),
// images and their layers, containers, networks, volumes and a Compose project.
// run(world, line) returns the next world, the text a real terminal would print,
// and a list of events the picture animates. The engine has no clock and no
// randomness, so the same commands always give the same world: that is what lets
// the grader replay a student's log and get exactly what the student saw.
//
// It models only what COMPSCI 426 teaches (Units 02 and 04). Anything else answers
// "not simulated here", never a guess.

import { parseYaml } from "./yaml.js";

export const ENGINE_VERSION = "0.1.0";

const POSTGIS = "ghcr.io/umass-cs-426/postgis:17-3.7";
const NODE = "node:24.14-bookworm-slim";
// Base images the simulated registry can pull, with what a container from each runs.
const REGISTRY = {
  [NODE]: { size: "235MB", program: "node", env: {}, cmd: ["node"], fs: ["/usr/local/bin/node"] },
  [POSTGIS]: {
    size: "966MB", program: "postgres", env: { PGDATA: "/var/lib/postgresql/data" }, cmd: ["postgres"],
    fs: ["/docker-entrypoint-initdb.d", "/var/lib/postgresql/data"], volumes: ["/var/lib/postgresql/data"],
  },
};
const PROJECT = "valley-map";
const DB_INIT_STEPS = 2; // a fresh data volume takes this many commands to initialise

// ---------- small helpers ----------

const clone = (x) => JSON.parse(JSON.stringify(x));

// A short, stable hash (FNV-1a), shown as an id and used as a build-cache key.
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Split a command line into words, honouring single and double quotes.
export function words(line) {
  const out = [];
  let cur = "", quote = null, any = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch; any = true;
    } else if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = ""; any = false;
    } else cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

// Split a line on a separator (| or &&), but never inside quotes.
export function splitOutside(line, sep) {
  const out = [];
  let cur = "", q = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
    if (line.startsWith(sep, i) && !(sep === "|" && line[i + 1] === "|")) { out.push(cur.trim()); cur = ""; i += sep.length - 1; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((s) => s !== "");
}

// Read a .env file into an object.
export function parseEnv(text = "") {
  const env = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return env;
}

// $VAR and ${VAR} in a typed command come from the repo's .env, as if it were loaded.
function expandShell(line, env) {
  return line.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, k) => (k in env ? env[k] : ""));
}

// ${VAR}, ${VAR:-default} and ${VAR:?message} in a Compose file.
function interpolate(text, env, where) {
  return String(text).replace(/\$\{([A-Z_][A-Z0-9_]*)(?:(:-|:\?)([^}]*))?\}/g, (m, k, op, rest) => {
    if (env[k] !== undefined && env[k] !== "") return env[k];
    if (op === ":-") return rest;
    if (op === ":?") throw new SimError(`error while interpolating ${where}: required variable ${k} is missing a value: ${rest}`);
    return "";
  });
}

class SimError extends Error {}

// ---------- the world ----------

export function newWorld(files = {}) {
  return {
    engine: ENGINE_VERSION,
    step: 0,
    line: 0,
    nextId: 1,
    host: { files: clone(files), ports: {} },
    images: {},
    cache: {},
    lastBuild: null,
    containers: {},
    networks: { bridge: { name: "bridge", builtin: true, dns: false, subnet: "172.17.0" } },
    volumes: {},
    project: null,
    facts: [],
  };
}

const newId = (w, seed) => hash(`${seed}-${w.nextId++}`) + hash(`${w.nextId}`).slice(0, 4);

function containerByRef(w, ref) {
  return Object.values(w.containers).find((c) => c.name === ref || c.id.startsWith(ref));
}

function fact(w, type, data = {}) {
  w.facts.push({ step: w.step, type, ...data });
}

// ---------- the public entry point ----------

// Run one command line. Returns { world, out, events, ok }. `world` is a new object;
// the one passed in is never changed.
export function run(world, line) {
  const w = clone(world);
  w.step += 1;
  w.line += 1;
  const events = [];
  tick(w, events);
  let out = "", ok = true;
  const env = parseEnv(w.host.files[".env"]);
  const parts = splitOutside(line, "&&");
  for (const part of parts) {
    try {
      const r = runOne(w, expandShell(part, env), events);
      out += r;
    } catch (err) {
      if (!(err instanceof SimError)) throw err;
      out += err.message + "\n";
      ok = false;
      break; // && stops at the first failure, as in a real shell
    }
    tick(w, events);
  }
  return { world: w, out, events, ok };
}

// Edit a file in the repo (from the file editors). Returns a new world.
export function setFile(world, path, text) {
  const w = clone(world);
  w.host.files[path] = text;
  return w;
}

// Let time pass: databases finish starting, and so on.
function tick(w, events) {
  for (const c of Object.values(w.containers)) {
    if (c.state === "running" && c.program === "postgres" && !c.ready && w.step >= c.readyAt) {
      c.ready = true;
      c.logs.push("LOG:  database system is ready to accept connections");
      events.push({ type: "ready", id: c.id });
    }
  }
}

function runOne(w, line, events) {
  const pipe = splitOutside(line, "|");
  const argv = words(pipe[0]);
  if (!argv.length) return "";
  const [cmd, ...rest] = argv;
  if (cmd === "docker" && rest[0] === "compose") return compose(w, rest.slice(1), events);
  if (cmd === "docker") return docker(w, rest, events);
  if (cmd === "curl") return curl(w, rest, pipe.slice(1), events);
  if (cmd === "clear") return "";
  if (cmd === "help") return HELP;
  throw new SimError(`${cmd}: not simulated here. This simulator runs docker, docker compose and curl; try it on your own machine.`);
}

const HELP = `Commands this simulator runs:
  docker build -t NAME [-f FILE] .         docker images
  docker run [-d] [--rm] [--name N] [-p HOST:CONTAINER] [-e K=V] [-v VOLUME:/path] IMAGE [command]
  docker ps [-a]   docker logs NAME   docker exec NAME COMMAND   docker stop NAME   docker rm [-f] [-v] NAME
  docker volume ls | create NAME | rm NAME     docker network ls | create NAME
  docker compose up [-d] [--build] [--scale SERVICE=N]   docker compose ps | logs SERVICE | exec SERVICE COMMAND | down [-v]
  curl [-s] [-i] URL [| jq '.features | length']
`;

// ---------- docker ----------

function docker(w, args, events) {
  const [sub, ...a] = args;
  switch (sub) {
    case "build": return build(w, a, events);
    case "run": return dockerRun(w, a, events);
    case "ps": return ps(w, a.includes("-a") || a.includes("--all"));
    case "images": return images(w);
    case "logs": {
      const c = containerByRef(w, a.filter((x) => !x.startsWith("-")).at(-1) || "");
      if (!c) throw new SimError(`Error response from daemon: No such container: ${a.at(-1) ?? ""}`);
      return c.logs.join("\n") + (c.logs.length ? "\n" : "");
    }
    case "exec": return dockerExec(w, a, events);
    case "stop": return a.map((ref) => stop(w, ref, events) && ref).join("\n") + "\n";
    case "kill": return a.map((ref) => stop(w, ref, events, true) && ref).join("\n") + "\n";
    case "start": {
      const c = containerByRef(w, a[0] || "");
      if (!c) throw new SimError(`Error response from daemon: No such container: ${a[0] ?? ""}`);
      start(w, c, events);
      return `${a[0]}\n`;
    }
    case "rm": {
      const force = a.includes("-f") || a.includes("--force");
      const vols = a.includes("-v") || a.includes("--volumes");
      return a.filter((x) => !x.startsWith("-")).map((ref) => removeContainer(w, ref, force, vols, events) && ref).join("\n") + "\n";
    }
    case "volume": return volume(w, a, events);
    case "network": return network(w, a);
    case "image":
      if (a[0] === "ls") return images(w);
      if (a[0] === "inspect") return inspectImage(w, a[1]);
      break;
    case "inspect": {
      const c = containerByRef(w, a[0] || "");
      if (c) return JSON.stringify(publicContainer(c), null, 2) + "\n";
      return inspectImage(w, a[0]);
    }
    case "pull": return pull(w, a[0], events);
    case "system":
      if (a[0] === "df") return systemDf(w);
      break;
    case "version": return "Client: Docker Engine (simulated)\n Version: 27.x\nServer: Docker Desktop (simulated)\n";
  }
  throw new SimError(`docker ${sub ?? ""}: not simulated here. Try "help" for what is.`);
}

function pull(w, name, events) {
  name = normalizeImage(name);
  if (w.images[name]) return `${name}: already present\n`;
  const base = REGISTRY[name];
  if (!base) throw new SimError(`Error response from daemon: pull access denied for ${name.split(":")[0]}, repository does not exist or may require 'docker login'`);
  w.images[name] = {
    name, id: hash(name), size: base.size, program: base.program, env: clone(base.env), cmd: base.cmd,
    workdir: "/", fs: [...base.fs], volumes: base.volumes || [], layers: [{ text: `FROM ${name}`, key: hash(name), status: "pulled" }],
  };
  events.push({ type: "pull", image: name });
  return `${name.split(":")[1] || "latest"}: Pulling from ${name.split(":")[0]}\nStatus: Downloaded newer image for ${name}\n`;
}

const normalizeImage = (n = "") => (n.includes(":") ? n : `${n}:latest`);

// .dockerignore: a pattern matches a path, or any folder the path sits in.
function ignored(path, patterns) {
  return patterns.some((p) => {
    const pat = p.replace(/^\*\*\//, "").replace(/\/$/, "");
    const segs = path.split("/");
    if (p.startsWith("**/")) return segs.includes(pat);
    return path === pat || path.startsWith(pat + "/");
  });
}

function buildContext(w) {
  const patterns = (w.host.files[".dockerignore"] || "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const files = {};
  for (const [p, t] of Object.entries(w.host.files)) if (!ignored(p, patterns)) files[p] = t;
  return files;
}

// docker build: walk the Dockerfile, reuse cached layers until the first changed input.
function build(w, a, events, opts = {}) {
  let tag = null, file = "Dockerfile";
  const pos = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "-t" || a[i] === "--tag") tag = a[++i];
    else if (a[i] === "-f" || a[i] === "--file") file = a[++i];
    else if (a[i] === "--progress" || a[i] === "-q") { if (a[i] === "--progress") i++; }
    else if (a[i].startsWith("--progress=")) continue;
    else pos.push(a[i]);
  }
  if (!pos.length) throw new SimError(`ERROR: docker buildx build requires exactly 1 argument.\nUsage:  docker buildx build [OPTIONS] PATH | URL | -`);
  if (pos[0] !== ".") throw new SimError(`This simulator builds from the top of the repo: use "." as the build context.`);
  const text = w.host.files[file];
  if (text === undefined) throw new SimError(`ERROR: failed to solve: failed to read dockerfile: open ${file}: no such file or directory`);
  const ctx = buildContext(w);
  const steps = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!steps.length || !/^FROM\s/i.test(steps[0])) throw new SimError(`ERROR: failed to solve: the Dockerfile must start with FROM`);
  const n = steps.length;
  let out = `[+] Building (simulated)\n`;
  let key = "", workdir = "/", env = {}, cmd = null, fs = [], program = null, expose = [], baseVolumes = [];
  const layers = [];
  let copiedPkg = false, copiedLock = false, ran = 0;
  for (let i = 0; i < n; i++) {
    const s = steps[i];
    const [ins, ...restWords] = words(s);
    const INS = ins.toUpperCase();
    const label = `#${i + 1} [${i + 1}/${n}] ${s}`;
    let input = s;
    if (INS === "FROM") {
      const base = normalizeImage(restWords[0]);
      if (!REGISTRY[base] && !w.images[base]) throw new SimError(`${label}\nERROR: failed to solve: ${restWords[0]}: not found (the simulator knows ${NODE} and ${POSTGIS})`);
      if (!w.images[base]) pull(w, base, events);
      const b = w.images[base];
      env = clone(b.env); cmd = b.cmd; fs = [...b.fs]; program = b.program; workdir = b.workdir; baseVolumes = b.volumes || [];
      key = hash(base);
      layers.push({ text: s, key, status: "base" });
      out += `${label}\n#${i + 1} DONE 0.0s\n`;
      continue;
    }
    if (INS === "COPY") {
      const dest = restWords.at(-1);
      const srcs = restWords.slice(0, -1);
      let content = "";
      for (const src of srcs) {
        const clean = src.replace(/\/$/, "").replace(/^\.\//, "");
        const matched = Object.keys(ctx).filter((p) => clean === "." || p === clean || p.startsWith(clean + "/")).sort();
        if (!matched.length) throw new SimError(`${label}\nERROR: failed to solve: failed to compute cache key: failed to calculate checksum of ref: "/${clean}": not found`);
        for (const p of matched) {
          content += p + "\n" + ctx[p];
          const rel = clean === "." ? p : p === clean ? p.split("/").at(-1) : p.slice(clean.length + 1);
          const base = dest.startsWith("/") ? dest : `${workdir}/${dest}`;
          const target = (base.endsWith("/") || matched.length > 1 || p !== clean ? base.replace(/\/$/, "") + "/" + rel : base).replace(/\/\.\//g, "/").replace(/\/+/g, "/");
          fs.push(target);
          if (p.endsWith("package.json")) copiedPkg = true;
          if (p.endsWith("package-lock.json")) copiedLock = true;
        }
      }
      input = s + hash(content);
    } else if (INS === "WORKDIR") {
      workdir = restWords[0];
      fs.push(workdir);
    } else if (INS === "ENV") {
      const [k, v] = restWords[0].includes("=") ? restWords[0].split("=") : restWords;
      env[k] = v;
    } else if (INS === "EXPOSE") {
      expose.push(Number(restWords[0]));
    } else if (INS === "CMD") {
      cmd = JSON.parse(s.slice(4).trim().replace(/'/g, '"'));
    } else if (INS === "RUN") {
      if (/npm ci/.test(s) && !(copiedPkg && copiedLock)) {
        throw new SimError(`${label}\nnpm error code EUSAGE\nnpm error The \`npm ci\` command can only install with an existing package-lock.json.\nERROR: failed to solve: process "/bin/sh -c ${restWords.join(" ")}" did not complete successfully: exit code: 1`);
      }
      if (/npm ci/.test(s)) fs.push(`${workdir}/node_modules`);
    } else if (INS !== "LABEL" && INS !== "USER" && INS !== "ARG") {
      throw new SimError(`${label}\n${ins}: not simulated here`);
    }
    key = hash(key + input);
    const cached = !!w.cache[key];
    w.cache[key] = true;
    const time = INS === "RUN" && /npm ci/.test(s) ? "0.5s" : "0.0s";
    layers.push({ text: s, key, status: cached ? "cached" : "built" });
    if (!cached) ran++;
    out += cached ? `${label}\n#${i + 1} CACHED\n` : `${label}\n#${i + 1} DONE ${time}\n`;
  }
  // What the image runs: a node server in this repo is places-api.
  if (cmd && cmd.join(" ").includes("src/server.js")) program = "places-api";
  tag = normalizeImage(tag || `sha256-${key.slice(0, 8)}`);
  const imageFiles = {};
  for (const p of fs) imageFiles[p] = true;
  w.images[tag] = {
    name: tag, id: hash(tag + key), size: program === "places-api" ? "353MB" : REGISTRY[NODE].size, program, env, cmd,
    workdir, fs: Object.keys(imageFiles).sort(), volumes: baseVolumes, layers, expose, builtFrom: file,
    srcHash: hash(Object.entries(ctx).filter(([p]) => p.startsWith("places-api/src")).map(([p, t]) => p + t).join("")),
    hasData: Object.keys(imageFiles).some((p) => p.endsWith("data/places.json")),
    hasEnvFile: Object.keys(imageFiles).some((p) => p.endsWith("/.env")),
  };
  w.lastBuild = { image: tag, layers: clone(layers), rebuilt: ran };
  events.push({ type: "build", image: tag, layers: clone(layers) });
  fact(w, "build", { image: tag, cached: layers.filter((l) => l.status === "cached").map((l) => l.text), built: layers.filter((l) => l.status === "built").map((l) => l.text) });
  if (!opts.quiet) out += `#${n + 1} exporting to image\n#${n + 1} naming to docker.io/library/${tag} done\n`;
  return out;
}

function images(w) {
  const rows = Object.values(w.images).map((i) => [i.name.split(":")[0], i.name.split(":")[1], i.id.slice(0, 12), i.size]);
  return table(["REPOSITORY", "TAG", "IMAGE ID", "SIZE"], rows);
}

function inspectImage(w, ref) {
  const i = w.images[normalizeImage(ref)];
  if (!i) throw new SimError(`Error: No such object: ${ref}`);
  return JSON.stringify({ Id: i.id, RepoTags: [i.name], Config: { Env: Object.entries(i.env).map(([k, v]) => `${k}=${v}`), Cmd: i.cmd, WorkingDir: i.workdir }, Layers: i.layers.map((l) => l.text) }, null, 2) + "\n";
}

function table(head, rows) {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (r) => r.map((c, i) => String(c ?? "").padEnd(widths[i] + 3)).join("").trimEnd();
  return [line(head), ...rows.map(line)].join("\n") + "\n";
}

// docker run
function dockerRun(w, a, events) {
  const o = { detach: false, rm: false, name: null, ports: [], env: {}, vols: [], network: null };
  let i = 0;
  for (; i < a.length; i++) {
    const x = a[i];
    if (x === "-d" || x === "--detach") o.detach = true;
    else if (x === "--rm") o.rm = true;
    else if (x === "-it" || x === "-i" || x === "-t") continue;
    else if (x === "--name") o.name = a[++i];
    else if (x === "-p" || x === "--publish") o.ports.push(a[++i]);
    else if (x === "-e" || x === "--env") { const [k, ...v] = a[++i].split("="); o.env[k] = v.join("="); }
    else if (x === "-v" || x === "--volume") o.vols.push(a[++i]);
    else if (x === "--network") o.network = a[++i];
    else if (x.startsWith("-")) throw new SimError(`docker run ${x}: not simulated here`);
    else break;
  }
  const imageName = normalizeImage(a[i]);
  if (!a[i]) throw new SimError(`docker: 'docker run' requires at least 1 argument.`);
  const override = a.slice(i + 1);
  if (!w.images[imageName]) {
    if (REGISTRY[imageName]) pull(w, imageName, events);
    else throw new SimError(`Unable to find image '${imageName}' locally\ndocker: Error response from daemon: pull access denied for ${imageName.split(":")[0]}, repository does not exist or may require 'docker login'.`);
  }
  if (o.name && containerByRef(w, o.name)) {
    const other = containerByRef(w, o.name);
    throw new SimError(`docker: Error response from daemon: Conflict. The container name "/${o.name}" is already in use by container "${other.id}". You have to remove (or rename) that container to be able to reuse that name.`);
  }
  const c = createContainer(w, {
    image: imageName, name: o.name, env: o.env, rm: o.rm, network: o.network || "bridge",
    ports: o.ports.map((p) => { const [h, ct] = p.split(":"); return { host: Number(h), container: Number(ct ?? h) }; }),
    vols: o.vols, override,
  }, events);
  start(w, c, events);
  // A one-off command (docker run IMAGE ls /app) runs and exits.
  if (override.length) {
    const outText = programExec(w, c, override, events);
    c.state = "exited"; c.exitCode = 0; releasePorts(w, c);
    if (c.rm) removeContainer(w, c.id, true, true, events);
    return outText;
  }
  if (c.state === "exited" && c.rm) {
    const logs = c.logs.join("\n") + "\n";
    removeContainer(w, c.id, true, true, events);
    return logs;
  }
  return o.detach ? `${c.id}\n` : c.logs.join("\n") + "\n" + `(the simulator runs it in the background; it keeps running until you stop it)\n`;
}

function createContainer(w, o, events) {
  const img = w.images[o.image];
  const id = newId(w, o.image);
  const name = o.name || `${["quirky", "eager", "brave", "calm"][w.nextId % 4]}_${["turing", "hopper", "lovelace", "knuth"][w.nextId % 4]}`;
  const env = { ...img.env, ...o.env };
  const mounts = [];
  for (const v of o.vols || []) {
    const [src, path, mode] = v.split(":");
    if (src.startsWith("./") || src.startsWith("/")) {
      mounts.push({ kind: "bind", source: src.replace(/^\.\//, ""), path, readonly: mode === "ro" });
    } else {
      if (!w.volumes[src]) { w.volumes[src] = { name: src, anonymous: false, data: { tables: {} } }; events.push({ type: "volume", name: src }); }
      mounts.push({ kind: "volume", source: src, path });
    }
  }
  // The image asks for a volume (the database's data folder): make an unnamed one if none was given.
  for (const path of img.volumes || []) {
    if (!mounts.some((m) => m.path === path)) {
      const anon = hash(`anon-${id}`) + hash(`anon2-${id}`) + hash(`a3${id}`);
      w.volumes[anon] = { name: anon, anonymous: true, data: { tables: {} } };
      mounts.push({ kind: "volume", source: anon, path, anonymous: true });
    }
  }
  const c = {
    id, name, image: o.image, program: img.program, state: "created", exitCode: null, rm: !!o.rm,
    env, ports: o.ports || [], mounts, networks: [o.network || "bridge"], aliases: o.aliases || [],
    ip: {}, logs: [], service: o.service || null, index: o.index || null, healthcheck: o.healthcheck || null,
    cmd: (o.override && o.override.length) ? o.override : img.cmd,
  };
  w.containers[id] = c;
  events.push({ type: "create", id });
  return c;
}

function assignIp(w, c) {
  for (const net of c.networks) {
    const n = w.networks[net];
    const used = Object.values(w.containers).filter((x) => x.ip[net]).length;
    c.ip[net] = `${n.subnet}.${used + 2}`;
  }
}

function start(w, c, events) {
  for (const p of c.ports) {
    const holder = w.host.ports[p.host];
    if (holder && holder !== c.id) {
      delete w.containers[c.id];
      throw new SimError(`docker: Error response from daemon: driver failed programming external connectivity on endpoint ${c.name}: Bind for 0.0.0.0:${p.host} failed: port is already allocated.`);
    }
  }
  for (const p of c.ports) w.host.ports[p.host] = c.id;
  c.state = "running"; c.exitCode = null; c.startedAt = w.step;
  assignIp(w, c);
  events.push({ type: "start", id: c.id });
  const img = w.images[c.image];
  if (c.program === "places-api") {
    if (!img.hasData) {
      c.logs.push(`node:internal/fs/utils:356\n    throw err;\n    ^\n\nError: ENOENT: no such file or directory, open '/app/data/places.json'`);
      exit(w, c, 1, events);
      return;
    }
    const port = Number(c.env.PORT || 3000);
    c.listen = [port];
    c.logs.push(`places-api: 1351 places on http://localhost:${port} (SLOW_RATE=${c.env.SLOW_RATE || 0})`);
  } else if (c.program === "postgres") {
    if (!c.env.POSTGRES_PASSWORD) {
      c.logs.push("Error: Database is uninitialized and superuser password is not specified.\n       You must specify POSTGRES_PASSWORD to a non-empty value for the\n       superuser.");
      exit(w, c, 1, events);
      return;
    }
    const data = dataVolume(w, c);
    c.listen = [5432];
    c.ready = false;
    if (!data.initialized) {
      c.readyAt = w.step + DB_INIT_STEPS;
      c.logs.push("The files belonging to this database system will be owned by user \"postgres\".", "creating database ...");
      for (const m of c.mounts.filter((m) => m.kind === "bind" && m.path.startsWith("/docker-entrypoint-initdb.d"))) {
        const sql = w.host.files[m.source];
        if (sql !== undefined) { runSql(w, c, sql, data, true); c.logs.push(`/usr/local/bin/docker-entrypoint.sh: running ${m.path}`); }
      }
      data.initialized = true;
      data.user = c.env.POSTGRES_USER || "postgres";
      data.db = c.env.POSTGRES_DB || data.user;
    } else {
      c.readyAt = w.step + 1;
      c.logs.push("PostgreSQL Database directory appears to contain a database; Skipping initialization");
    }
  } else if (c.program === "node") {
    exit(w, c, 0, events);
  }
}

function dataVolume(w, c) {
  const m = c.mounts.find((m) => m.path === "/var/lib/postgresql/data");
  return w.volumes[m.source].data;
}

function exit(w, c, code, events) {
  c.state = "exited"; c.exitCode = code; c.ready = false;
  releasePorts(w, c);
  events.push({ type: "exit", id: c.id, name: c.name, code });
}

function releasePorts(w, c) {
  for (const [p, id] of Object.entries(w.host.ports)) if (id === c.id) delete w.host.ports[p];
}

function stop(w, ref, events, kill = false) {
  const c = containerByRef(w, ref);
  if (!c) throw new SimError(`Error response from daemon: No such container: ${ref}`);
  if (c.state === "running") exit(w, c, kill ? 137 : 0, events);
  if (c.rm) removeContainer(w, c.id, true, true, events);
  return true;
}

function removeContainer(w, ref, force, vols, events) {
  const c = containerByRef(w, ref);
  if (!c) throw new SimError(`Error response from daemon: No such container: ${ref}`);
  if (c.state === "running" && !force) throw new SimError(`Error response from daemon: cannot remove container "/${c.name}": container is running: stop the container before removing or force remove`);
  if (c.state === "running") exit(w, c, 137, events);
  delete w.containers[c.id];
  if (vols) for (const m of c.mounts) if (m.anonymous) delete w.volumes[m.source];
  events.push({ type: "remove", id: c.id, name: c.name });
  return true;
}

function ps(w, all) {
  const rows = Object.values(w.containers).filter((c) => all || c.state === "running").map((c) => [
    c.id.slice(0, 12), c.image.replace(/:latest$/, ""), JSON.stringify(c.cmd.join(" ")).slice(0, 24),
    c.state === "running" ? `Up ${w.step - (c.startedAt ?? w.step) + 1} steps${health(w, c) ? ` (${health(w, c)})` : ""}` : `Exited (${c.exitCode})`,
    c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(", "), c.name,
  ]);
  return table(["CONTAINER ID", "IMAGE", "COMMAND", "STATUS", "PORTS", "NAMES"], rows);
}

function health(w, c) {
  if (!c.healthcheck || c.state !== "running") return "";
  return c.ready ? "healthy" : "health: starting";
}

function systemDf(w) {
  return table(["TYPE", "TOTAL", "ACTIVE"], [
    ["Images", Object.keys(w.images).length, new Set(Object.values(w.containers).map((c) => c.image)).size],
    ["Containers", Object.keys(w.containers).length, Object.values(w.containers).filter((c) => c.state === "running").length],
    ["Local Volumes", Object.keys(w.volumes).length, new Set(Object.values(w.containers).flatMap((c) => c.mounts.filter((m) => m.kind === "volume").map((m) => m.source))).size],
  ]);
}

function volume(w, a, events) {
  const [sub, name] = a;
  if (sub === "ls") return table(["DRIVER", "VOLUME NAME"], Object.values(w.volumes).map((v) => ["local", v.name]));
  if (sub === "create") { w.volumes[name] = w.volumes[name] || { name, anonymous: false, data: { tables: {} } }; events.push({ type: "volume", name }); return name + "\n"; }
  if (sub === "rm") {
    const inUse = Object.values(w.containers).find((c) => c.mounts.some((m) => m.source === name));
    if (!w.volumes[name]) throw new SimError(`Error response from daemon: get ${name}: no such volume`);
    if (inUse) throw new SimError(`Error response from daemon: remove ${name}: volume is in use - [${inUse.id}]`);
    delete w.volumes[name]; events.push({ type: "remove-volume", name }); return name + "\n";
  }
  throw new SimError(`docker volume ${sub}: not simulated here`);
}

function network(w, a) {
  const [sub, name] = a;
  if (sub === "ls") return table(["NETWORK ID", "NAME", "DRIVER"], Object.values(w.networks).map((n) => [hash(n.name).slice(0, 12), n.name, "bridge"]));
  if (sub === "create") {
    w.networks[name] = { name, builtin: false, dns: true, subnet: `172.${18 + Object.keys(w.networks).length}.0` };
    return hash(name) + "\n";
  }
  throw new SimError(`docker network ${sub}: not simulated here`);
}

// ---------- programs: what runs inside a container ----------

function dockerExec(w, a, events) {
  const rest = a.filter((x) => x !== "-it" && x !== "-i" && x !== "-t" && x !== "-T");
  const c = containerByRef(w, rest[0] || "");
  if (!c) throw new SimError(`Error response from daemon: No such container: ${rest[0] ?? ""}`);
  if (c.state !== "running") throw new SimError(`Error response from daemon: container ${c.id} is not running`);
  return programExec(w, c, rest.slice(1), events);
}

function programExec(w, c, cmd, events) {
  const [prog, ...args] = cmd;
  const img = w.images[c.image];
  events.push({ type: "exec", id: c.id, cmd: cmd.join(" ") });
  fact(w, "exec", { container: c.id, image: c.image, cmd: cmd.join(" ") });
  if (prog === "sh" || prog === "bash") return `(The simulator can't open a shell. Run one command at a time instead, for example:\n  docker exec ${c.name} ls -a /app)\n`;
  if (prog === "id") return "uid=0(root) gid=0(root) groups=0(root)\n";
  if (prog === "env") return Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  if (prog === "hostname") return c.id.slice(0, 12) + "\n";
  if (prog === "ls") {
    const dir = (args.filter((x) => !x.startsWith("-"))[0] || img.workdir || "/").replace(/\/$/, "");
    const kids = new Set();
    for (const p of img.fs) {
      if (p.startsWith(dir + "/")) kids.add(p.slice(dir.length + 1).split("/")[0]);
    }
    for (const m of c.mounts) if (m.path.startsWith(dir + "/")) kids.add(m.path.slice(dir.length + 1).split("/")[0]);
    if (!kids.size && !img.fs.includes(dir)) throw new SimError(`ls: cannot access '${dir}': No such file or directory`);
    const list = [...kids].sort();
    return (args.includes("-a") ? [".", "..", ...list] : list).join("\n") + "\n";
  }
  if (prog === "node" && (args[0] === "--version" || args[0] === "-v")) return "v24.14.1\n";
  if (prog === "pg_isready") return c.ready ? `127.0.0.1:5432 - accepting connections\n` : `127.0.0.1:5432 - no response\n`;
  if (prog === "psql") return psql(w, c, args);
  if (prog === "npm" && args[0] === "run" && args[1] === "seed") return seed(w, c, events);
  if (prog === "npm" && args[0] === "test") return "(The simulator doesn't run the test suite; run npm test on your own machine.)\n";
  throw new SimError(`${prog}: not simulated here inside a container.`);
}

// Where does a connection from container `from` to host:port go?
function connect(w, from, host, port) {
  if (host === "localhost" || host === "127.0.0.1") {
    if (from && from.state === "running" && (from.listen || []).includes(port) && (from.program !== "postgres" || from.ready)) return { ok: true, to: from };
    return { ok: false, error: `connect ECONNREFUSED 127.0.0.1:${port}` };
  }
  const shared = Object.values(w.containers).filter((c) => c.networks.some((n) => from.networks.includes(n) && w.networks[n].dns));
  const target = shared.find((c) => c.name === host || c.service === host || c.aliases.includes(host));
  if (!target) return { ok: false, error: `getaddrinfo ENOTFOUND ${host}` };
  const ip = target.ip[target.networks.find((n) => from.networks.includes(n))];
  if (target.state !== "running" || !(target.listen || []).includes(port) || (target.program === "postgres" && !target.ready)) return { ok: false, error: `connect ECONNREFUSED ${ip}:${port}`, to: target };
  return { ok: true, to: target, ip };
}

function dbFor(w, c, events) {
  const url = c.env.DATABASE_URL;
  if (!url) return { ok: false, error: "DATABASE_URL is not set" };
  const m = url.match(/^postgres(?:ql)?:\/\/([^:]*):([^@]*)@([^:/]+):(\d+)\/(\w+)/);
  if (!m) return { ok: false, error: `Invalid URL: ${url}` };
  const [, user, password, host, port] = m;
  const r = connect(w, c, host, Number(port));
  events.push({ type: "request", from: c.id, to: r.to?.id || null, port: Number(port), ok: r.ok, error: r.error });
  if (!r.ok) return r;
  if (r.to.env.POSTGRES_PASSWORD !== password) return { ok: false, error: `password authentication failed for user "${user}"` };
  return { ok: true, db: dataVolume(w, r.to), dbContainer: r.to };
}

function seed(w, c, events) {
  if (c.program !== "places-api") throw new SimError("npm error Missing script: \"seed\"");
  const r = dbFor(w, c, events);
  if (!r.ok) {
    fact(w, "seed-failed", { error: r.error, linesSinceUp: w.project ? w.line - w.project.upLine : null });
    throw new SimError(`Error: ${r.error}\n    at seed (/app/places-api/seed/load-places.js:22:11)`);
  }
  if (!r.db.tables.places) throw new SimError(`error: relation "places" does not exist`);
  r.db.tables.places.rows = Array.from({ length: 1351 }, (_, i) => ({ by: c.id, n: i }));
  fact(w, "seed-ok", { linesSinceUp: w.project ? w.line - w.project.upLine : null, freshDb: !!w.project?.freshDb });
  return "places table now has 1351 rows\n";
}

// A very small SQL: CREATE TABLE, INSERT, SELECT *, SELECT count(*).
function runSql(w, c, sql, data, quiet = false) {
  const out = [];
  for (const raw of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    const stmt = raw.replace(/--.*$/gm, "").trim();
    if (!stmt) continue;
    let m;
    if (/^CREATE\s+(EXTENSION|INDEX)/i.test(stmt)) { out.push(stmt.match(/^CREATE\s+(\w+)/i)[1].toUpperCase() === "INDEX" ? "CREATE INDEX" : "CREATE EXTENSION"); continue; }
    if (/^ANALYZE/i.test(stmt)) { out.push("ANALYZE"); continue; }
    if ((m = stmt.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i))) {
      if (data.tables[m[1]] && !/IF\s+NOT\s+EXISTS/i.test(stmt)) throw new SimError(`ERROR:  relation "${m[1]}" already exists`);
      data.tables[m[1]] = data.tables[m[1]] || { rows: [] };
      out.push("CREATE TABLE");
    } else if ((m = stmt.match(/^INSERT\s+INTO\s+(\w+)\s*(?:\(([^)]*)\))?\s*VALUES\s*\((.*)\)$/is))) {
      const t = data.tables[m[1]];
      if (!t) throw new SimError(`ERROR:  relation "${m[1]}" does not exist\nLINE 1: INSERT INTO ${m[1]}`);
      const vals = m[3].split(",").map((v) => v.trim().replace(/^'(.*)'$/, "$1"));
      t.rows.push({ by: c.id, values: vals });
      fact(w, "insert", { table: m[1], container: c.id });
      out.push("INSERT 0 1");
    } else if ((m = stmt.match(/^SELECT\s+(.+?)\s+FROM\s+(\w+)/is))) {
      const t = data.tables[m[2]];
      if (!t) { fact(w, "select-missing", { table: m[2], container: c.id }); throw new SimError(`ERROR:  relation "${m[2]}" does not exist\nLINE 1: SELECT ${m[1]} FROM ${m[2]};\n                      ^`); }
      fact(w, "select", { table: m[2], container: c.id, rows: t.rows.map((r) => r.by) });
      if (/count\(\*\)/i.test(m[1])) out.push(` count \n-------\n ${String(t.rows.length).padStart(5)}\n(1 row)\n`);
      else {
        const body = t.rows.map((r, i) => ` ${String(i + 1).padStart(2)} | ${(r.values || []).join(" | ")}`).join("\n");
        out.push(` id | body\n----+------------------------------\n${body}${body ? "\n" : ""}(${t.rows.length} row${t.rows.length === 1 ? "" : "s"})\n`);
      }
    } else throw new SimError(`(The simulator's SQL knows CREATE TABLE, INSERT and SELECT only.)`);
  }
  return quiet ? "" : out.join("\n") + "\n";
}

function psql(w, c, args) {
  if (c.program !== "postgres") throw new SimError("psql: not found in this container");
  if (!c.ready) throw new SimError(`psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is starting up`);
  const sqls = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "-c" || args[i] === "--command") sqls.push(args[++i]);
  if (!sqls.length) return "(Give psql a statement with -c, for example: psql -U postgres -c \"SELECT 1\")\n";
  const data = dataVolume(w, c);
  return sqls.map((s) => runSql(w, c, s, data)).join("");
}

// ---------- curl, from the laptop ----------

const KNOWN_BOXES = { "-72.55,42.33,-72.45,42.42": 127, "-72.55,42.33,-72.525,42.348": 9, "-72.6,42.3,-72.4,42.4": 118 };

function curl(w, a, pipes, events) {
  let include = false, method = "GET";
  const urls = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "-i" || a[i] === "--include") include = true;
    else if (a[i] === "-s" || a[i] === "-k" || a[i] === "-sk" || a[i] === "-ks" || a[i] === "-L") continue;
    else if (a[i] === "-si" || a[i] === "-is") include = true;
    else if (a[i] === "-X") method = a[++i];
    else if (a[i] === "-o" || a[i] === "-w" || a[i] === "-D") i++;
    else urls.push(a[i]);
  }
  const url = urls[0];
  const m = (url || "").match(/^(?:https?:\/\/)?(localhost|127\.0\.0\.1):(\d+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new SimError(`curl: (6) Could not resolve host: ${(url || "").replace(/^https?:\/\//, "").split(/[:/]/)[0]} (the simulator's curl reaches localhost only)`);
  const port = Number(m[2]), path = m[3] || "/", query = new URLSearchParams((m[4] || "").slice(1));
  const id = w.host.ports[port];
  const c = id && w.containers[id];
  const containerPort = c && c.ports.find((p) => p.host === port).container;
  const listening = c && c.state === "running" && (c.listen || []).includes(containerPort);
  events.push({ type: "request", from: "host", to: c ? c.id : null, port, ok: !!listening });
  if (!listening) throw new SimError(`curl: (7) Failed to connect to localhost port ${port} after 0 ms: Couldn't connect to server`);
  let status = 200, body;
  if (c.program === "places-api") {
    if (path === "/health") {
      if (c.env.DATABASE_URL) {
        const r = dbFor(w, c, events);
        body = r.ok ? { ok: true, places: r.db.tables.places ? r.db.tables.places.rows.length : 0 } : { ok: false, error: r.error };
        if (!r.ok) status = 503;
      } else body = { ok: true, places: 1351, slowRate: Number(c.env.SLOW_RATE || 0), slowMs: 100 };
    } else if (path === "/places") {
      const bbox = query.get("bbox");
      const parts = (bbox || "").split(",").map(Number);
      if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x)) || parts[0] > parts[2] || parts[1] > parts[3]) {
        status = 400; body = { error: "bbox must be west,south,east,north in degrees" };
      } else {
        let n = KNOWN_BOXES[bbox] ?? (parseInt(hash(bbox).slice(0, 4), 16) % 200);
        if (c.env.DATABASE_URL) {
          const r = dbFor(w, c, events);
          if (!r.ok) { status = 500; body = { error: r.error }; }
          else if (!r.db.tables.places || !r.db.tables.places.rows.length) n = 0;
        }
        if (status === 200) body = { type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", id: `place-${i + 1}` })) };
      }
    } else { status = 404; body = `Cannot GET ${path}`; }
  } else { status = 404; body = ""; }
  fact(w, "http", { from: "host", port, path, status, container: c.id, count: body && body.features ? body.features.length : null });
  let text = typeof body === "string" ? body : JSON.stringify(body);
  if (pipes.length) {
    const jq = words(pipes[0]);
    if (jq[0] !== "jq") throw new SimError(`${jq[0]}: not simulated here (the simulator's pipes go to jq)`);
    const expr = jq.filter((x) => !x.startsWith("-"))[1] || ".";
    text = miniJq(body, expr);
  } else if (text.length > 400) {
    text = text.slice(0, 400) + `... (${text.length.toLocaleString("en-US")} characters in all; try | jq '.features | length')`;
  }
  const head = include ? `HTTP/1.1 ${status} ${{ 200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable" }[status]}\nContent-Type: application/json; charset=utf-8\n\n` : "";
  return head + text + "\n";
}

function miniJq(body, expr) {
  if (expr === ".") return JSON.stringify(body, null, 2);
  if (expr === ".features | length") return String(body.features ? body.features.length : "null");
  if (expr === ".ok") return String(body.ok);
  if (expr === ".places") return String(body.places);
  if (expr === ".features[0]") return JSON.stringify(body.features?.[0] ?? null, null, 2);
  return `(The simulator's jq knows '.', '.features | length', '.features[0]', '.ok' and '.places'.)`;
}

// ---------- docker compose ----------

function readCompose(w) {
  const text = w.host.files["docker-compose.yml"];
  if (text === undefined) throw new SimError("no configuration file provided: not found");
  let doc;
  try { doc = parseYaml(text); } catch (e) { throw new SimError(`yaml: ${e.message}`); }
  if (!doc || !doc.services) throw new SimError("services must be a mapping");
  return doc;
}

function compose(w, a, events) {
  const [sub, ...rest] = a;
  if (sub === "up") return composeUp(w, rest, events);
  if (sub === "down") return composeDown(w, rest.includes("-v") || rest.includes("--volumes"), events);
  if (sub === "ps") {
    const rows = Object.values(w.containers).filter((c) => c.service && c.state === "running").map((c) => [
      c.name, c.image.replace(/:latest$/, ""), c.service, `Up${health(w, c) ? ` (${health(w, c)})` : ""}`,
      c.ports.map((p) => `0.0.0.0:${p.host}->${p.container}/tcp`).join(", "),
    ]);
    return table(["NAME", "IMAGE", "SERVICE", "STATUS", "PORTS"], rows);
  }
  if (sub === "logs") {
    const svc = rest.filter((x) => !x.startsWith("-"))[0];
    const cs = Object.values(w.containers).filter((c) => c.service && (!svc || c.service === svc));
    return cs.map((c) => c.logs.map((l) => `${c.service}-${c.index}  | ${l}`).join("\n")).join("\n") + "\n";
  }
  if (sub === "exec") {
    const r = rest.filter((x) => x !== "-T" && x !== "-it");
    let index = 1, i = 0;
    if (r[0] === "--index") { index = Number(r[1]); i = 2; }
    const c = Object.values(w.containers).find((x) => x.service === r[i] && x.index === index);
    if (!c) throw new SimError(`service "${r[i]}" is not running`);
    if (c.state !== "running") throw new SimError(`service "${r[i]}" is not running`);
    return programExec(w, c, r.slice(i + 1), events);
  }
  if (sub === "restart") {
    for (const c of Object.values(w.containers).filter((c) => c.service && (!rest[0] || c.service === rest[0]))) { exit(w, c, 0, events); start(w, c, events); }
    return "";
  }
  if (sub === "build") {
    const doc = readCompose(w);
    let out = "";
    for (const [name, s] of Object.entries(doc.services)) if (s.build) out += buildService(w, name, s, events);
    return out;
  }
  throw new SimError(`docker compose ${sub ?? ""}: not simulated here`);
}

function buildService(w, name, s, events) {
  const b = typeof s.build === "string" ? { context: s.build } : s.build;
  const ctx = b.context || ".";
  if (ctx !== ".") throw new SimError(`This simulator builds from the top of the repo: use "context: ." and "dockerfile:" for ${name}.`);
  return build(w, ["-t", `${PROJECT}-${name}`, "-f", b.dockerfile || "Dockerfile", "."], events, { quiet: true });
}

function composeUp(w, a, events) {
  const doc = readCompose(w);
  const env = parseEnv(w.host.files[".env"]);
  const scale = {};
  for (let i = 0; i < a.length; i++) if (a[i] === "--scale") { const [s, n] = a[++i].split("="); scale[s] = Number(n); }
  const rebuild = a.includes("--build");
  let out = "";
  const net = `${PROJECT}_default`;
  if (!w.networks[net]) {
    w.networks[net] = { name: net, builtin: false, dns: true, subnet: "192.168.80" };
    out += ` ✔ Network ${net}  Created\n`;
    events.push({ type: "network", name: net });
  }
  const freshDb = !Object.values(w.volumes).some((v) => v.name.startsWith(PROJECT + "_") && v.data.initialized);
  w.project = { name: PROJECT, upStep: w.step, upLine: w.line, freshDb };
  // Start services in depends_on order.
  const order = [], seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    const deps = doc.services[n].depends_on;
    for (const d of Array.isArray(deps) ? deps : Object.keys(deps || {})) {
      if (!doc.services[d]) throw new SimError(`service "${n}" depends on undefined service "${d}": invalid compose project`);
      visit(d);
    }
    order.push(n);
  };
  Object.keys(doc.services).forEach(visit);
  for (const name of order) {
    const s = doc.services[name];
    if (s.profiles) continue;
    const where = `services.${name}`;
    const senv = {};
    for (const [k, v] of Object.entries(s.environment || {})) senv[k] = interpolate(v, env, `${where}.environment.${k}`);
    let image = s.image ? normalizeImage(s.image) : `${PROJECT}-${name}:latest`;
    if (s.build && (rebuild || !w.images[image])) out += buildService(w, name, s, events);
    if (!s.build && !w.images[image]) {
      if (!REGISTRY[image]) throw new SimError(`Error response from daemon: pull access denied for ${image.split(":")[0]}`);
      pull(w, image, events);
      out += ` ✔ ${name} Pulled\n`;
    }
    // Wait for dependencies that must be healthy first.
    const deps = s.depends_on && !Array.isArray(s.depends_on) ? s.depends_on : {};
    for (const [d, cond] of Object.entries(deps)) {
      if (cond && cond.condition === "service_healthy") {
        const dc = Object.values(w.containers).find((c) => c.service === d && c.state === "running");
        if (!dc || !dc.healthcheck) throw new SimError(`dependency failed to start: container ${PROJECT}-${d}-1 has no healthcheck configured`);
        while (!dc.ready && dc.state === "running") { w.step += 1; tick(w, events); }
        if (!dc.ready) throw new SimError(`dependency failed to start: container ${PROJECT}-${d}-1 exited (${dc.exitCode})`);
        out += ` ✔ Container ${dc.name}  Healthy\n`;
      }
    }
    const n = scale[name] ?? 1;
    const existing = Object.values(w.containers).filter((c) => c.service === name);
    for (let i = 1; i <= n; i++) {
      let c = existing.find((x) => x.index === i);
      const vols = (s.volumes || []).map((v) => {
        const [src, ...restV] = String(v).split(":");
        return src.startsWith(".") || src.startsWith("/") ? v : `${PROJECT}_${src}:${restV.join(":")}`;
      });
      for (const v of vols) { const src = v.split(":")[0]; if (!src.startsWith(".") && !w.volumes[src]) out += ` ✔ Volume ${src}  Created\n`; }
      const ports = (s.ports || []).map((p) => { const [h, ct] = interpolate(p, env, `${where}.ports`).split(":"); return { host: Number(h), container: Number(ct) }; });
      if (n > 1 && ports.length) throw new SimError(`Error response from daemon: Bind for 0.0.0.0:${ports[0].host} failed: port is already allocated (remove "ports:" from ${name} to run copies)`);
      const aliases = s.networks && s.networks.default && s.networks.default.aliases ? s.networks.default.aliases : [];
      // Recreate a container only if its settings or its image changed, as Compose does.
      const config = hash(JSON.stringify({ s, senv, image: w.images[image].id }));
      if (c && c.state === "running" && c.config === config) { out += ` ✔ Container ${c.name}  Running\n`; continue; }
      if (c) removeContainer(w, c.id, true, false, events);
      c = createContainer(w, { image, name: `${PROJECT}-${name}-${i}`, env: senv, ports, vols, network: net, service: name, index: i, healthcheck: s.healthcheck || null, aliases }, events);
      c.config = config;
      c.startedAt = w.step;
      start(w, c, events);
      out += ` ✔ Container ${c.name}  Started\n`;
    }
    for (const c of existing.filter((x) => x.index > n)) { removeContainer(w, c.id, true, false, events); out += ` ✔ Container ${c.name}  Removed\n`; }
  }
  fact(w, "compose-up", { services: order, freshDb });
  return out;
}

function composeDown(w, vols, events) {
  let out = "";
  for (const c of Object.values(w.containers).filter((c) => c.service)) {
    removeContainer(w, c.id, true, true, events);
    out += ` ✔ Container ${c.name}  Removed\n`;
  }
  if (vols) for (const v of Object.values(w.volumes).filter((v) => v.name.startsWith(PROJECT + "_"))) { delete w.volumes[v.name]; out += ` ✔ Volume ${v.name}  Removed\n`; }
  if (w.networks[`${PROJECT}_default`]) { delete w.networks[`${PROJECT}_default`]; out += ` ✔ Network ${PROJECT}_default  Removed\n`; }
  w.project = null;
  return out;
}

function publicContainer(c) {
  return { Id: c.id, Name: "/" + c.name, Image: c.image, State: { Status: c.state, ExitCode: c.exitCode }, Config: { Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`), Cmd: c.cmd }, Mounts: c.mounts, NetworkSettings: { Networks: c.ip, Ports: c.ports } };
}

// ---------- goal checks, shared by the app and the grader ----------

// Each check is plain data from an activity file; check(world, spec) says whether it holds.
export function check(w, spec) {
  const running = Object.values(w.containers).filter((c) => c.state === "running");
  switch (spec.type) {
    case "all": return spec.of.every((s) => check(w, s));
    case "execSeen": return w.facts.some((f) => f.type === "exec" && new RegExp(spec.match).test(f.cmd) && (!spec.image || f.image === normalizeImage(spec.image)));
    case "imageExists": return !!w.images[normalizeImage(spec.image)];
    case "imageLacks": { const i = w.images[normalizeImage(spec.image)]; return !!i && !i.fs.some((p) => p.endsWith(spec.path)); }
    case "containerRunning":
      return running.some((c) => (!spec.image || c.image === normalizeImage(spec.image)) && (!spec.program || c.program === spec.program)
        && (!spec.publish || c.ports.some((p) => p.host === spec.publish.host && p.container === spec.publish.container))
        && (!spec.env || Object.entries(spec.env).every(([k, v]) => c.env[k] === v)));
    case "httpSeen": return w.facts.some((f) => f.type === "http" && f.path === spec.path && f.status === (spec.status ?? 200) && (spec.count === undefined || f.count === spec.count) && (!spec.port || f.port === spec.port));
    case "buildReused": return w.facts.some((f) => f.type === "build" && f.cached.some((t) => t.includes(spec.cached)) && f.built.some((t) => t.includes(spec.rebuilt)));
    case "rowReadByAnother": return w.facts.some((f) => f.type === "select" && f.table === spec.table && f.rows.some((by) => by !== f.container));
    case "tableMissingSeen": return w.facts.some((f) => f.type === "select-missing");
    case "noContainers": return !Object.values(w.containers).some((c) => !spec.program || c.program === spec.program);
    case "serviceRunning": return running.some((c) => c.service === spec.service);
    case "serviceNoPorts": return running.some((c) => c.service === spec.service) && running.filter((c) => c.service === spec.service).every((c) => !c.ports.length);
    case "seedOk": return w.facts.some((f) => f.type === "seed-ok" && (!spec.fresh || f.freshDb) && (spec.withinLines === undefined || (f.linesSinceUp ?? 99) <= spec.withinLines));
    case "composeHas": { try { const d = readCompose(w); return pathHas(d, spec.path, spec.value); } catch { return false; } }
    default: return false;
  }
}

function pathHas(obj, path, value) {
  let cur = obj;
  for (const k of path.split(".")) { if (cur == null) return false; cur = cur[k]; }
  return value === undefined ? cur !== undefined : JSON.stringify(cur).includes(value);
}

// Replay a log of commands and file edits from a starting world (used by the grader and on import).
export function replay(start, log) {
  let w = start;
  for (const e of log) {
    if (e.kind === "cmd") w = run(w, e.text).world;
    else if (e.kind === "edit") w = setFile(w, e.path, e.text);
    else if (e.kind === "reset") w = start;
  }
  return w;
}
