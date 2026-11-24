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
      { id: "no-env", text: "The image holds no .env file", check: { type: "imageLacks", image: "places-api", path: "/.env" } },
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

export const activityById = (id) => ACTIVITIES.find((a) => a.id === id);
