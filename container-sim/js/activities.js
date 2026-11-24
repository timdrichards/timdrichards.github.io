// activities.js: the simulator's activities, as plain data. Each one has a starting repo,
// goals the engine checks (engine.js, check()), predictions asked before a command runs,
// hints, and the same task to do for real. Add an activity by adding an object here.

const SERVER_V1 = `// server.js: the Valley Map places API (Unit 01), answering from places.json in memory.
import express from "express";
const PORT = Number(process.env.PORT ?? 3000);
const SLOW_RATE = Number(process.env.SLOW_RATE ?? 0);
// ...
app.listen(PORT, () => console.log(\`places-api: 1351 places on http://localhost:\${PORT} (SLOW_RATE=\${SLOW_RATE})\`));
`;

const DOCKERFILE = `# places-api image. Build context is the repo root, so web/ and data/ can be copied in.
FROM node:24.14-bookworm-slim
WORKDIR /app/places-api
# Dependencies first, so editing source code does not reinstall them.
COPY places-api/package.json places-api/package-lock.json ./
RUN npm ci --omit=dev
COPY places-api/ ./
COPY web/ /app/web/
COPY data/ /app/data/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
`;

const DOCKERFILE_SLOW_ORDER = `# places-api image. It works, but every change to server.js reinstalls every package.
FROM node:24.14-bookworm-slim
WORKDIR /app/places-api
COPY places-api/ ./
RUN npm ci --omit=dev
COPY web/ /app/web/
COPY data/ /app/data/
ENV PORT=3000
EXPOSE 3000
CMD ["node", "src/server.js"]
`;

const DOCKERIGNORE = `# .dockerignore: what docker build must never copy into an image.
**/node_modules
.env
.git
results
load
`;

const INIT_SQL = `-- init.sql: runs once, the first time the db volume is created.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE TABLE places (
  id   text PRIMARY KEY,
  name text NOT NULL,
  geom geometry(Point, 4326) NOT NULL
);
`;

const COMPOSE_RACE = `# The Valley Map, Unit 04: places-api and its database.
services:
  places-api:
    build:
      context: .
      dockerfile: places-api/Dockerfile
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://valleymap:\${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}@db:5432/valleymap
    depends_on:
      - db

  db:
    image: ghcr.io/umass-cs-426/postgis:17-3.7
    environment:
      POSTGRES_USER: valleymap
      POSTGRES_DB: valleymap
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
    volumes:
      - ./db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
      - db-data:/var/lib/postgresql/data

volumes:
  db-data:
`;

// The repo after Unit 01, as each student has it.
export function repoUnit01() {
  return {
    "places-api/package.json": `{ "name": "places-api", "version": "1.0.0", "type": "module", "dependencies": { "express": "5.3.0" } }\n`,
    "places-api/package-lock.json": `{ "name": "places-api", "lockfileVersion": 3, "packages": { "node_modules/express": { "version": "5.3.0" } } }\n`,
    "places-api/src/server.js": SERVER_V1,
    "places-api/src/places.js": "// places.js: parseBbox and placesInBbox\n",
    "places-api/src/geo.js": "// geo.js: toFeature and toWebMercator\n",
    "places-api/node_modules/express/package.json": `{ "name": "express", "version": "5.3.0" }\n`,
    "web/index.html": "<!-- the map page -->\n",
    "data/places.json": "[ /* 1,351 places */ ]\n",
    "load/baseline.js": "// k6 baseline\n",
    "results/baseline.md": "# Baseline\n",
    ".env.example": "POSTGRES_PASSWORD=change-me\n",
    ".env": "POSTGRES_PASSWORD=my-own-secret\n",
    ".gitignore": ".env\nnode_modules/\n",
  };
}

const withFiles = (base, extra) => ({ ...base, ...extra });

export const ACTIVITIES = [
  {
    id: "u02-container",
    unit: "02",
    version: 1,
    title: "The map in a container",
    intro: "Package the Unit 01 places-api as an image and run it. The Dockerfile is written for you in the Files pane; read it line by line first.",
    files: () => withFiles(repoUnit01(), { "places-api/Dockerfile": DOCKERFILE, ".dockerignore": DOCKERIGNORE }),
    suggested: [
      "docker build -t places-api -f places-api/Dockerfile .",
      "docker images",
      "docker run -d --name places-api -p 3000:3000 places-api",
      "docker ps",
      "curl -s 'http://localhost:3000/places?bbox=-72.55,42.33,-72.45,42.42' | jq '.features | length'",
      "docker run --rm places-api ls -a /app",
    ],
    goals: [
      { id: "built", text: "An image named places-api exists", check: { type: "imageExists", image: "places-api" } },
      { id: "running", text: "A places-api container runs with laptop port 3000 connected to its port 3000", check: { type: "containerRunning", program: "places-api", publish: { host: 3000, container: 3000 } } },
      { id: "answers", text: "From the laptop, the Amherst box returns 127 places", check: { type: "httpSeen", path: "/places", status: 200, count: 127 } },
      { id: "no-env", text: "You looked inside the image and it holds no .env file", check: { type: "all", of: [{ type: "execSeen", match: "^ls", image: "places-api" }, { type: "imageLacks", image: "places-api", path: "/.env" }] } },
    ],
    predictions: [
      { id: "no-port", when: "^docker run(?!.*-p ).*places-api", question: "You are starting places-api with no -p. What will curl localhost:3000 do afterwards?", choices: ["Return the places as usual", "Fail to connect", "Return 404"], answer: 1 },
      { id: "first-run", when: "^docker run .*-p 3000:3000", question: "Where does port 3000 on your laptop lead after this command?", choices: ["Nowhere; containers can't be reached", "Into this container's port 3000", "To every container"], answer: 1 },
    ],
    hints: [
      "Build from the top of the repo: the final . is the build context, and -f says where the Dockerfile is.",
      "-p 3000:3000 connects laptop port 3000 to container port 3000. Without it, nothing outside can reach the container.",
      "docker run --rm places-api ls -a /app runs one command in a fresh container and lists what the image holds.",
    ],
    forReal: ["docker build -t places-api -f places-api/Dockerfile .", "docker run --rm -p 3000:3000 places-api", "curl -s 'http://localhost:3000/places?bbox=-72.55,42.33,-72.45,42.42' | jq '.features | length'"],
  },
  {
    id: "u02-layers",
    unit: "02",
    version: 1,
    title: "Make the rebuild skip npm ci",
    intro: "This Dockerfile copies all the source before npm ci, so every edit reinstalls every package. Build it, change server.js, and rebuild to see. Then reorder the Dockerfile so a change to server.js reuses the npm ci layer.",
    files: () => withFiles(repoUnit01(), { "places-api/Dockerfile": DOCKERFILE_SLOW_ORDER, ".dockerignore": DOCKERIGNORE }),
    suggested: ["docker build -t places-api -f places-api/Dockerfile .", "(edit places-api/src/server.js in Files, then build again)"],
    goals: [
      { id: "reused", text: "After a change to server.js, the rebuild reuses RUN npm ci and rebuilds COPY places-api/", check: { type: "buildReused", cached: "RUN npm ci", rebuilt: "COPY places-api/" } },
    ],
    predictions: [
      { id: "rebuild", when: "^docker build", question: "Since your last build you changed server.js. Which steps will run again?", choices: ["Only the COPY of the source", "The COPY of the source and every step after it", "Every step from FROM down"], answer: 1 },
    ],
    hints: [
      "Docker reuses saved layers from the top down and stops at the first step whose input changed.",
      "Copy only package.json and package-lock.json, run npm ci, and copy the rest of places-api/ after that.",
    ],
    forReal: ["docker build --progress=plain -t places-api -f places-api/Dockerfile ."],
  },
  {
    id: "u02-volume",
    unit: "02",
    version: 1,
    title: "Keep the data",
    intro: "Run the course database image with a named volume, write a row, throw the container away, and read the row from a new container. Then try it without a volume. The password comes from .env.",
    files: () => repoUnit01(),
    suggested: [
      "docker run -d --name db1 -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD -v pgdata:/var/lib/postgresql/data ghcr.io/umass-cs-426/postgis:17-3.7",
      "docker exec db1 psql -U postgres -c \"CREATE TABLE notes (id serial PRIMARY KEY, body text)\" -c \"INSERT INTO notes (body) VALUES ('written by the first container')\"",
      "docker rm -f db1",
      "docker run -d --name db2 -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD -v pgdata:/var/lib/postgresql/data ghcr.io/umass-cs-426/postgis:17-3.7",
      "docker exec db2 psql -U postgres -c \"SELECT * FROM notes\"",
    ],
    goals: [
      { id: "survives", text: "A container reads a row that a different container wrote", check: { type: "rowReadByAnother", table: "notes" } },
      { id: "lost", text: "Without a volume, a new container finds no notes table", check: { type: "tableMissingSeen" } },
    ],
    predictions: [
      { id: "after-rm", when: "^docker run .*--name db2", question: "db1 is gone. Will db2 see the row db1 wrote?", choices: ["Yes, if both use the volume pgdata", "No, removing the container deleted the data", "Only if db2 has the same name"], answer: 0 },
    ],
    hints: [
      "If psql says the database is starting up, wait: run docker ps or docker logs once, then try again.",
      "-v pgdata:/var/lib/postgresql/data puts the database's files in a volume that outlives the container.",
      "For the second part, run two containers without -v: the second one starts with an empty database.",
    ],
    forReal: ["docker volume ls", "docker rm -f -v db3 db4"],
  },
  {
    id: "u04-reach-db",
    unit: "04",
    version: 1,
    title: "Make the API reach the database",
    intro: "Two containers started by hand can't find each other: localhost means the container itself, and the default network has no names. Fix the Compose file in Files so both start together, places-api reaches db by name, and db has no published port.",
    files: () => withFiles(repoUnit01(), {
      "places-api/Dockerfile": DOCKERFILE, ".dockerignore": DOCKERIGNORE, "db/init.sql": INIT_SQL,
      "docker-compose.yml": COMPOSE_RACE.replace("@db:5432", "@localhost:5432").replace("    volumes:\n      - ./db/init.sql", "    ports:\n      - \"5432:5432\"\n    volumes:\n      - ./db/init.sql"),
    }),
    suggested: ["docker compose up -d", "curl -s http://localhost:3000/health", "(fix docker-compose.yml)", "docker compose up -d --build", "docker compose ps", "docker compose exec places-api npm run seed", "curl -s http://localhost:3000/health"],
    goals: [
      { id: "both", text: "places-api and db run in one Compose project", check: { type: "serviceRunning", service: "db" } },
      { id: "no-db-port", text: "db publishes no port to the laptop", check: { type: "serviceNoPorts", service: "db" } },
      { id: "seeded", text: "places-api loaded the places into db (npm run seed)", check: { type: "seedOk" } },
      { id: "healthy", text: "/health through places-api reports the places", check: { type: "httpSeen", path: "/health", status: 200 } },
    ],
    predictions: [
      { id: "localhost", when: "^curl .*health", question: "DATABASE_URL says localhost:5432. Inside the places-api container, what is localhost?", choices: ["The laptop", "The places-api container itself", "The db container"], answer: 1 },
    ],
    hints: [
      "In a Compose project, each service is reachable from the others by its service name: db, not localhost.",
      "Delete db's ports: entry. Only containers on the project network need to reach it.",
      "If seeding fails with ECONNREFUSED, the database may still be starting: check docker compose ps.",
    ],
    forReal: ["docker compose up -d --build", "docker compose exec places-api npm run seed", "curl -s localhost:3000/health"],
  },
  {
    id: "u04-race",
    unit: "04",
    version: 1,
    title: "Win the startup race",
    intro: "With plain depends_on, Compose starts places-api as soon as db's container starts, not when the database is ready. Seed straight after a fresh start and watch it fail. Then add a health check and the condition so the same commands always work.",
    files: () => withFiles(repoUnit01(), { "places-api/Dockerfile": DOCKERFILE, ".dockerignore": DOCKERIGNORE, "db/init.sql": INIT_SQL, "docker-compose.yml": COMPOSE_RACE }),
    suggested: [
      "docker compose down -v && docker compose up -d && docker compose exec places-api npm run seed",
      "(add a healthcheck to db and condition: service_healthy to places-api)",
      "docker compose down -v && docker compose up -d && docker compose exec places-api npm run seed",
    ],
    goals: [
      { id: "healthcheck", text: "db has a healthcheck", check: { type: "composeHas", path: "services.db.healthcheck" } },
      { id: "condition", text: "places-api waits for service_healthy", check: { type: "composeHas", path: "services.places-api.depends_on.db.condition", value: "service_healthy" } },
      { id: "seed-fresh", text: "Seeding right after a fresh start works (same command line as up)", check: { type: "seedOk", fresh: true, withinLines: 0 } },
    ],
    predictions: [
      { id: "race", when: "npm run seed", question: "The database volume was just deleted, so db must create a fresh database first. Will this seed work?", choices: ["Yes", "No: db isn't ready yet", "It depends on your compose file"], answer: 2 },
    ],
    hints: [
      "A health check: healthcheck: with test: [\"CMD\", \"pg_isready\", \"-h\", \"127.0.0.1\", \"-U\", \"valleymap\", \"-d\", \"valleymap\"].",
      "depends_on can be a mapping: depends_on: then db: then condition: service_healthy.",
    ],
    forReal: ["docker compose down -v && docker compose up -d && docker compose exec places-api npm run seed"],
  },
];


// ---------- guided steps ----------
// Each step: what to do (text), a command to run or a file to edit, what to watch for in
// the picture, what it means afterwards, and how the app knows the step is done.
const FIX_LAYERS = { path: "places-api/Dockerfile", find: "COPY places-api/ ./\nRUN npm ci --omit=dev", replace: "COPY places-api/package.json places-api/package-lock.json ./\nRUN npm ci --omit=dev\nCOPY places-api/ ./" };
const TOUCH_SERVER = (n) => ({ path: "places-api/src/server.js", append: `// change ${n}: a new comment\n` });

const STEPS = {
  "u02-container": [
    { title: "Read the recipe", open: "places-api/Dockerfile",
      text: "An image is built from a recipe called a Dockerfile. It's open on the right. Each line is one step: start from Node.js, copy the package list, install the packages, copy the code, say how to start it.",
      watch: "Nothing changes yet: you're only reading.", after: "", done: { read: true } },
    { title: "Build the image", cmd: "docker build -t places-api -f places-api/Dockerfile .",
      text: "docker build follows the recipe and saves the result as an image named places-api. The final . means: you may copy files from the top of this repo.",
      watch: "A new image appears under Images: a stack of bars, one per Dockerfile line.",
      after: "The image is a packaged copy of places-api with its own Node.js and packages. It is a recipe, already cooked and frozen: nothing is running yet.", done: { goal: "built" } },
    { title: "Start a container", cmd: "docker run -d --name places-api -p 3000:3000 places-api",
      text: "docker run starts a container: one running copy of the image. -p 3000:3000 connects port 3000 on your laptop to port 3000 inside the container.",
      watch: "A container box appears inside the network, and a blue pipe joins your laptop's port 3000 to it.",
      after: "The container is running in its own little world: its own files, its own network address, its own localhost. The pipe is the only way in from your laptop.", done: { goal: "running" } },
    { title: "Ask it for places", cmd: "curl -s 'http://localhost:3000/places?bbox=-72.55,42.33,-72.45,42.42' | jq '.features | length'",
      text: "curl sends the request from your laptop, exactly as in Unit 01. jq counts the places in the answer.",
      watch: "A green dot travels from your laptop through the pipe into the container.",
      after: "127: the same answer as Unit 01, now from a container. The map didn't change; how it's packaged and started did.", done: { goal: "answers" } },
    { title: "Look inside the image", cmd: "docker run --rm places-api ls -a /app",
      text: "Give docker run a command and the container runs just that command and stops. --rm throws the container away afterwards.",
      watch: "A container appears for a moment and is gone again. The terminal lists what's in /app.",
      after: "data, places-api and web, and no .env: the .dockerignore file kept your passwords out of the image. Anyone who has an image can read every file in it.", done: { goal: "no-env" } },
    { title: "Try it without -p", cmd: "docker run -d --name hidden places-api",
      text: "Start a second copy with no -p. It runs fine. Can anything reach it?",
      watch: "A second container appears, but no pipe leads to it.",
      after: "It's running and listening on its port 3000, but no pipe joins it to your laptop, so nothing outside can reach it. That's the sandbox: a container is reachable only where you say so.", done: { ran: "docker run .*--name hidden" } },
  ],
  "u02-layers": [
    { title: "Build it once", cmd: "docker build -t places-api -f places-api/Dockerfile .",
      text: "This Dockerfile works, but its order is wrong for fast rebuilds. Build it once so Docker saves every layer.",
      watch: "Every layer of the new image is amber: built this time.", after: "Docker saved the result of each line as a layer. Next time it can reuse them.", done: { ran: "docker build" } },
    { title: "Change one line of code", open: "places-api/src/server.js", edit: { ...TOUCH_SERVER(1), label: "Make the change for me" },
      text: "Edit places-api/src/server.js on the right: add a comment anywhere, like a developer fixing a typo. Or let the button do it.",
      watch: "Nothing yet: a change only matters when you build again.", after: "", done: { edited: { path: "places-api/src/server.js", changed: true } } },
    { title: "Build again", cmd: "docker build -t places-api -f places-api/Dockerfile .",
      text: "Rebuild with the changed code. Before it runs, you'll be asked which steps will run again.",
      watch: "The image's layers: green ones were reused, amber ones were rebuilt. Look at RUN npm ci.",
      after: "Docker reuses layers from the top down and stops at the first changed input. Here that's COPY places-api/, which comes before npm ci, so every package was installed again for a one-line change.", done: { ran: "docker build" } },
    { title: "Fix the order", open: "places-api/Dockerfile", edit: { ...FIX_LAYERS, label: "Show me the fix" },
      text: "Edit the Dockerfile so it copies only package.json and package-lock.json, runs npm ci, and only then copies the rest of places-api/. Try it yourself first; \"Show me the fix\" counts as a hint.",
      watch: "The checks under the editor stop warning about the order.", after: "", done: { edited: { path: "places-api/Dockerfile", contains: "COPY places-api/package.json" } } },
    { title: "Change the code and rebuild", cmd: "docker build -t places-api -f places-api/Dockerfile .", edit: { ...TOUCH_SERVER(2), label: "Change server.js for me first" },
      text: "Build once with the new order, change server.js again, and build again. (Two builds: the first saves the new layers.)",
      watch: "RUN npm ci is green: reused. Only the steps after COPY places-api/ are amber.",
      after: "That's the point of the order: the slow step sits above the code that changes all the time, so it stays cached. With hundreds of packages it saves minutes on every build.", done: { goal: "reused" } },
  ],
  "u02-volume": [
    { title: "Start a database with a volume", cmd: "docker run -d --name db1 -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD -v pgdata:/var/lib/postgresql/data ghcr.io/umass-cs-426/postgis:17-3.7",
      text: "This starts the course's database image. -e passes the password from .env. -v pgdata:... keeps the database's files in a volume named pgdata.",
      watch: "A dashed amber container (still starting) and a new cylinder, pgdata, joined to it.",
      after: "The database is setting itself up for the first time. Its files go into the volume, not into the container.", done: { ran: "docker run .*--name db1" } },
    { title: "Write a row", cmd: "docker exec db1 psql -U postgres -c \"CREATE TABLE notes (id serial PRIMARY KEY, body text)\" -c \"INSERT INTO notes (body) VALUES ('written by the first container')\"",
      text: "docker exec runs a command inside a running container: here psql, the database's own tool, creating a table and adding one row.",
      watch: "If the box is still amber, the database isn't ready: you'll get \"starting up\". Run docker ps, then try again.",
      after: "The row is stored in the pgdata volume.", done: { insert: true } },
    { title: "Throw the container away", cmd: "docker rm -f db1",
      text: "Remove the container completely.", watch: "The container box disappears. The pgdata cylinder stays.",
      after: "Containers are disposable. The volume, with the row in it, is still there.", done: { ran: "docker rm .*db1" } },
    { title: "Start a new container on the same volume", cmd: "docker run -d --name db2 -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD -v pgdata:/var/lib/postgresql/data ghcr.io/umass-cs-426/postgis:17-3.7",
      text: "A brand new container, db2, that has never seen that row, on the same volume.", watch: "db2 joined to the same pgdata cylinder.",
      after: "db2 found an existing database in the volume, so it skipped the setup.", done: { ran: "docker run .*--name db2" } },
    { title: "Read the row back", cmd: "docker exec db2 psql -U postgres -c \"SELECT * FROM notes\"",
      text: "Ask db2 for the notes.", watch: "The terminal shows the row. (If it says \"starting up\", run docker ps and try again.)",
      after: "db2 never ran the INSERT. The row came from the volume: programs are disposable, data is not.", done: { goal: "survives" } },
    { title: "Now try without a volume", cmd: "docker run -d --name db3 -e POSTGRES_PASSWORD=$POSTGRES_PASSWORD ghcr.io/umass-cs-426/postgis:17-3.7",
      text: "Start db3 with no -v, then ask it for the notes with the next step's command.", watch: "db3 gets an unnamed volume of its own (a dashed cylinder) that nothing else uses.",
      after: "The image asks for a volume, so Docker made a fresh unnamed one: an empty database.", done: { ran: "docker run .*--name db3" } },
    { title: "Ask db3 for the notes", cmd: "docker exec db3 psql -U postgres -c \"SELECT * FROM notes\"",
      text: "Same question as before.", watch: "An error in the terminal. (If it says \"starting up\", run docker ps and try again.)",
      after: "relation \"notes\" does not exist: without the volume, the row is gone. That's why every database in this course gets a named volume.", done: { goal: "lost" } },
  ],
  "u04-reach-db": [
    { title: "Start both services", cmd: "docker compose up -d", open: "docker-compose.yml",
      text: "The Compose file on the right describes both containers. docker compose up builds places-api and starts it with db, on a network of their own.",
      watch: "A new network with two containers. db has a pipe from your laptop: its port is published.",
      after: "Both are running. But look at DATABASE_URL in the file: places-api will look for the database at localhost.", done: { goal: "both" } },
    { title: "Ask places-api if it's healthy", cmd: "curl -s localhost:3000/health",
      text: "The /health route asks the database for a count. Predict what happens first.", watch: "A red line: places-api tries to reach the database and fails.",
      after: "ECONNREFUSED 127.0.0.1:5432. Inside a container, localhost is that container itself, and nothing in places-api listens on 5432. The database is in a different container.", done: { ran: "curl .*health" } },
    { title: "Fix the Compose file", open: "docker-compose.yml", edit: { path: "docker-compose.yml", find: "@localhost:5432", replace: "@db:5432", also: { find: '    ports:\n      - "5432:5432"\n', replace: "" }, label: "Show me the fix" },
      text: "Two changes: in DATABASE_URL, replace localhost with db, the service name; and delete db's ports: lines, since only places-api needs to reach it. The checks under the editor point at both.",
      watch: "The warnings under the editor go away.", after: "", done: { edited: { path: "docker-compose.yml", contains: "@db:5432" } } },
    { title: "Apply the change", cmd: "docker compose up -d --build",
      text: "docker compose up again: Compose recreates only the services whose settings changed.", watch: "db's pipe is gone. places-api is recreated.",
      after: "Both services are on the project network, where each finds the other by its service name.", done: { goal: "no-db-port" } },
    { title: "Load the places", cmd: "docker compose exec places-api npm run seed",
      text: "Run the seed script inside places-api. It connects to db:5432 and loads 1,351 places.", watch: "A green dot from places-api to db. (ECONNREFUSED means db is still starting: run docker compose ps and try again.)",
      after: "places-api reached db by name.", done: { goal: "seeded" } },
    { title: "Ask again", cmd: "curl -s localhost:3000/health",
      text: "Same question as step 2.", watch: "A green dot from your laptop to places-api, and from places-api to db.",
      after: "{\"ok\":true,\"places\":1351}. The fix was one word: a service name instead of localhost.", done: { goal: "healthy" } },
  ],
  "u04-race": [
    { title: "Start fresh and seed at once", cmd: "docker compose down -v && docker compose up -d && docker compose exec places-api npm run seed",
      text: "down -v deletes the database's volume, up starts everything, and the seed runs immediately. That's what CI does on every run.", open: "docker-compose.yml",
      watch: "db is amber and dashed: still creating its database when the seed tries to connect.",
      after: "ECONNREFUSED. depends_on only waits for db's container to start, not for the database inside it to be ready. On a fresh volume it needs a few seconds.", done: { ran: "npm run seed" } },
    { title: "Wait for healthy", open: "docker-compose.yml", edit: { path: "docker-compose.yml", find: "    depends_on:\n      - db\n", replace: "    depends_on:\n      db:\n        condition: service_healthy\n", also: { find: "      - db-data:/var/lib/postgresql/data\n", replace: "      - db-data:/var/lib/postgresql/data\n    healthcheck:\n      test: [\"CMD\", \"pg_isready\", \"-h\", \"127.0.0.1\", \"-U\", \"valleymap\", \"-d\", \"valleymap\"]\n      interval: 2s\n      retries: 30\n" }, label: "Show me the fix" },
      text: "Two changes: give db a healthcheck (pg_isready asks the database if it's ready), and make places-api's depends_on wait for condition: service_healthy.",
      watch: "The checks under the editor stop warning.", after: "", done: { goal: "condition" } },
    { title: "Run the same thing again", cmd: "docker compose down -v && docker compose up -d && docker compose exec places-api npm run seed",
      text: "Exactly the same command as step 1.", watch: "This time Compose waits: db turns blue (healthy) before places-api starts.",
      after: "\"Container db Healthy\", then the seed works. A health check turns \"the container started\" into \"the service is ready\".", done: { goal: "seed-fresh" } },
  ],
};

const MINUTES = { "u02-container": 10, "u02-layers": 10, "u02-volume": 12, "u04-reach-db": 12, "u04-race": 8 };
const SUMMARY = {
  "u02-container": "Build the Unit 01 places-api into an image, run it as a container, and reach it from your laptop.",
  "u02-layers": "See why the order of a Dockerfile decides how fast it rebuilds, and fix one that's slow.",
  "u02-volume": "Store a row in a database container, throw the container away, and get the row back.",
  "u04-reach-db": "Start the API and database together with Compose, and fix why they can't talk to each other.",
  "u04-race": "Watch a fresh start fail because the database isn't ready yet, then fix it with a health check."
};
for (const a of ACTIVITIES) { a.steps = STEPS[a.id]; a.minutes = MINUTES[a.id]; a.summary = SUMMARY[a.id]; }

export const activityById = (id) => ACTIVITIES.find((a) => a.id === id);
