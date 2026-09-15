# HackGrid backend

The server side of the HackGrid resource auction: an **Express 5 REST API** and
the **Socket.IO bidding rooms**, on one port, in one Node process, over a
Postgres database through **Prisma 7**.

This directory is a complete, standalone application. It has no dependency on
the frontend or on any parent directory — copy it into its own repository and
everything in this document still applies.

```
frontend (Next.js, Vercel)
        │  HTTPS  → /api/auction, /api/teams, /api/admin
        │  WSS    → /socket.io
        ▼
backend (this repo, Render)
        │  Prisma / pg
        ▼
Postgres (Neon, Render Postgres, …)
```

---

## Contents

1. [What is in here](#1-what-is-in-here)
2. [Requirements](#2-requirements)
3. [Setup](#3-setup)
4. [Environment variables](#4-environment-variables)
5. [Running the backend](#5-running-the-backend)
6. [How the server starts](#6-how-the-server-starts)
7. [WebSockets / Socket.IO](#7-websockets--socketio)
8. [REST API reference](#8-rest-api-reference)
9. [Organiser (admin) authentication](#9-organiser-admin-authentication)
10. [CORS](#10-cors)
11. [Database](#11-database)
12. [Deploying to Render](#12-deploying-to-render)
13. [Verifying a deployment](#13-verifying-a-deployment)
14. [Operational notes](#14-operational-notes)
15. [Troubleshooting](#15-troubleshooting)

---

## 1. What is in here

```
backend/
├── server.mjs               entry point: Express + Socket.IO on one http.Server
├── lib/
│   ├── auction-engine.mjs   capsule / pod / lot lifecycle (pure logic over Prisma)
│   ├── auction-hub.mjs      Socket.IO rooms: seating, bids, timers, settlement
│   ├── auction-rules.mjs    pure bid rules and timings (no I/O)
│   ├── auction-catalog.mjs  the four capsules and their tiers
│   ├── auction-router.mjs   /api/auction  — event state, team context, organiser shortcuts
│   ├── teams-router.mjs     /api/teams    — create / join / look up a team
│   ├── admin-router.mjs     /api/admin    — the organiser portal's API
│   └── organiser-auth.mjs   the gate in front of every organiser mutation
├── prisma/
│   └── schema.prisma        the database schema
├── prisma.config.mjs        Prisma 7 config (schema path, datasource URL)
├── package.json
├── package-lock.json
├── .env.example             every variable, documented
└── README.md                this file
```

Everything is plain JavaScript (ES modules, `.mjs`). **There is no compile or
bundling step.** `node server.mjs` is the whole story; the only "build" is
`prisma generate`, which produces the Prisma client from the schema.

---

## 2. Requirements

| Requirement | Version | Why |
| --- | --- | --- |
| Node.js | **≥ 20.12** (24.x tested) | `process.loadEnvFile()` and `node --watch-path` are used |
| npm | ≥ 9 | lockfile v3 |
| Postgres | any recent version | Neon is what the project has been run against; any Postgres works |

`package.json` declares `"engines": { "node": ">=20.12.0" }`.

---

## 3. Setup

```bash
git clone <this repository>
cd backend            # or the repository root, if this directory is the repo
npm install           # installs dependencies and runs `prisma generate` (postinstall)
cp .env.example .env  # then edit .env — at minimum set DATABASE_URL
npm run db:push       # creates / updates the tables in the database
npm run dev           # starts on http://localhost:4000
```

`npm install` runs `prisma generate` automatically through the `postinstall`
script. It does **not** need a database connection — a missing `DATABASE_URL`
at install time is fine (see `prisma.config.mjs`). Commands that do connect
(`db:push`, `db:studio`, and the server itself) need it.

To confirm the install without a database:

```bash
npm run check         # syntax-checks server.mjs and loads the engine module
```

---

## 4. Environment variables

Loaded from `.env` in the working directory (via Node's built-in
`process.loadEnvFile()`), or from the process environment — the host's
injected variables win. A missing `.env` file is not an error.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | **yes** | — | Postgres connection string. The server refuses to start without it. |
| `DATABASE_URL_PRODUCTION` | no | — | If set **and** the server is in production mode, replaces `DATABASE_URL`. Lets one `.env` hold both a dev and a live database without a dev run ever touching the live one. |
| `PORT` | no | `4000` | Port to listen on. **Render injects this — do not set it there.** |
| `HOST` | no | `0.0.0.0` | Interface to bind. `0.0.0.0` is required in a container (Render). Use `localhost` to keep a dev run private to your machine. |
| `NODE_ENV` | no | inferred | `production` or `development`. See [§6](#6-how-the-server-starts) for how it is inferred when unset. **Set `NODE_ENV=production` on Render.** |
| `CORS_ORIGIN` | **yes in production** | — | Comma-separated browser origins allowed to call the API and open sockets, e.g. `https://hackgrid.vercel.app,https://hackgrid-git-main-you.vercel.app`. Unset in development means any origin; unset in production means no browser origin. See [§10](#10-cors). |
| `ADMIN_API_KEY` | no | — | Shared secret that unlocks the organiser routes in production. Unset = organiser routes are closed in production. See [§9](#9-organiser-admin-authentication). |
| `HACKGRID_TIER_SECONDS` | no | `420` | How long a tier stays open with nobody bidding (7 min). |
| `HACKGRID_BID_TIMEOUT_SECONDS` | no | `13` | Anti-snipe window: a tier closes this long after the last accepted bid. |
| `HACKGRID_REMAINDER_SECONDS` | no | `90` | How long remainder-pod teams get to claim a tier at the frozen price. |

A minimal production `.env`:

```env
DATABASE_URL="postgresql://user:pass@host/db?sslmode=require"
NODE_ENV=production
CORS_ORIGIN="https://your-frontend.vercel.app"
ADMIN_API_KEY="a-long-random-string"
```

---

## 5. Running the backend

All commands run from this directory.

| Command | What it does |
| --- | --- |
| `npm run dev` | **Development.** Starts `server.mjs` under `node --watch-path`, restarting when `server.mjs` or anything in `lib/` changes. Runs in development mode: any CORS origin, organiser routes open, `/api/teams/users` returns the roster. |
| `npm start` | **Production.** `node server.mjs`, no watcher. Runs in production mode unless `NODE_ENV` says otherwise. This is Render's start command. |
| `node server.mjs` | Same as `npm start`. |
| `npm run build` | Runs `prisma generate`. Not required after `npm install` (postinstall already did it) but harmless; use it as an explicit build step on hosts that want one. |
| `npm run prisma:generate` | Same as `build`. |
| `npm run db:push` | `prisma db push` — creates or alters tables to match `prisma/schema.prisma`. Run once per new database and after any schema change. |
| `npm run db:studio` | Prisma Studio, a local GUI over the database. |
| `npm run check` | Syntax-check the entry point and load the engine; no database needed. |

There is **no separate build output**: no `dist/`, no transpilation. What you
see in the repository is what runs.

### Development vs production mode

Mode changes four things:

| | development | production |
| --- | --- | --- |
| CORS with `CORS_ORIGIN` unset | any origin allowed | no browser origin allowed |
| Organiser routes | open to anyone | require `ADMIN_API_KEY` (closed if unset) |
| `GET /api/teams/users` (the "act as" roster) | full user list | always `[]` |
| `DATABASE_URL_PRODUCTION` | ignored | replaces `DATABASE_URL` if set |

---

## 6. How the server starts

`server.mjs` is the only entry point. Top to bottom it:

1. Loads `.env` if present.
2. Decides the **mode**: an explicit `NODE_ENV` wins; otherwise `npm run dev`
   means development and everything else (`npm start`, `node server.mjs`, a
   host's start command) means production. It then writes the decision back
   to `process.env.NODE_ENV` so Prisma and the engine see the same answer.
3. In production, swaps in `DATABASE_URL_PRODUCTION` if set. Exits with an
   error if no `DATABASE_URL` is available.
4. Parses `CORS_ORIGIN` into the allow-list used by both Express and Socket.IO.
5. Creates the Express app and a Node `http.Server` around it.
6. **Creates the Socket.IO server attached to that same `http.Server`.**
7. Creates the **auction hub** (`lib/auction-hub.mjs`), which opens the Prisma
   client with a fixed pool of 10 connections. The hub owns the one Prisma
   client the whole process uses; the REST routers borrow it.
8. Mounts middleware (CORS, JSON body parsing with a 64 kB limit, request
   logging under `/api`) and the three routers plus `/health`.
9. Registers the Socket.IO handshake gate and connection handler.
10. `await hub.hydrate()` — warms the connection pool and reloads the timers
    of any lots that were open when the process last stopped, so a restart or
    redeploy mid-round does not lose the clock.
11. `httpServer.listen(PORT, HOST)` and prints a summary of the mode, CORS
    allow-list and organiser-gate state.
12. Handles `SIGINT`/`SIGTERM` by closing Socket.IO and the HTTP server so a
    redeploy stops cleanly.

---

## 7. WebSockets / Socket.IO

### Is it a separate process or build?

**No.** Socket.IO is created inside `server.mjs` and attached to the same
`http.Server` that Express listens on. `npm start` starts it. There is no
second command, no second port, no second service, and nothing to build.
`/socket.io` and `/api/*` are served by one process on one port.

### Where it is mounted

- Path: **`/socket.io`** (the Socket.IO default; the frontend's
  `lib/socket-events.ts` uses the same constant).
- Transports: WebSocket, with HTTP long-polling as Socket.IO's fallback.
- `serveClient: false` — the server does not serve the browser client script;
  the frontend bundles `socket.io-client` itself.

### Handshake and identity

The browser sends its identity in the Socket.IO **handshake `auth` object**,
never in the query string:

```ts
io("https://backend.example", {
  path: "/socket.io",
  auth: { podId: "<pod uuid>", teamId: 42, email: "lead@example.com" },
});
```

`server.mjs` checks this in an `io.use()` middleware before the connection is
accepted: `podId` must be a non-empty string, `teamId` an integer, `email` an
address. A bad handshake is refused with `connect_error` (`Missing or invalid
podId / teamId.` or `Missing the signed-in email.`).

On connection the hub's `attach()` verifies the email is **the lead of that
team**, that the team **is seated in that pod**, and that the pod's **round is
`LIVE`**. Anything else gets a `ROOM_ERROR` and is disconnected — only the
lead's account ever holds a seat, so a member opening the page can never count
towards the pod's quorum, and nobody enters a room before the organiser has
pressed Start on that round (*Start event* only draws the pods; it opens
nothing). When the organiser resets a round or the event, every socket in the
affected rooms is ejected the same way, so those leads fall back to the
bidding page's waiting state.

### Events

Server → client:

| Event | Payload | When |
| --- | --- | --- |
| `ROOM_STATE` | full room snapshot: pod, members (with `online`), your balances, every lot | on join, on `SYNC`, and after anything changes |
| `LOT_OPENED` | `{ lotId, name, closesAt }` | a tier's clock starts |
| `OUTBID` | `{ lotId, byTeamName, amount, nextMin }` | someone else's bid is now on top |
| `LOT_CLOSED` | `{ lotId, name, winnerTeamId, winnerTeamName, pricePaid }` | a tier settled |
| `POD_COMPLETE` | `{ podId }` | every tier in the pod settled |
| `CAPSULE_CLOSED` | `{ capsuleId, nextKey }` | the round finished (`nextKey` is what the organiser opens next; `null` after the last) |
| `CAPSULE_OPENED` | `{ capsuleKey, capsuleId }` | the organiser started a round — clients re-fetch their pod |
| `EVENT_COMPLETE` | — | all four rounds settled |
| `LOG` | `{ level, message, at }` | human-readable room log line |
| `ROOM_ERROR` | `{ message }` | the room refused something |

Client → server:

| Event | Payload | Reply |
| --- | --- | --- |
| `BID` | `{ lotId, amount }` | **acknowledgement** `{ ok: true, lotId, amount, bidId }` or `{ ok: false, lotId, code, reason, nextMin? }` |
| `SYNC` | — | a fresh `ROOM_STATE` to this socket only |

Every rule decision happens on the server. The client sends an intent; the
acknowledgement is the only thing that says whether it counted. Rejection
codes come from `BID_REJECTED` in `lib/auction-rules.mjs` — `LOT_NOT_OPEN`,
`LOT_EXPIRED`, `AUTO_ASSIGNED`, `NOT_IN_POD`, `ALREADY_WON`, `ALREADY_TOP`,
`ALREADY_CLAIMED`, `AWAITING_QUORUM`, `BELOW_MINIMUM`, `OVER_BUDGET`,
`RESERVE_LOCKED`, `NOT_INTEGER` — plus `UNKNOWN` for anything unexpected
(a lot outside your pod, a server fault).

### How the hub and the REST API interact

The organiser starts a round over HTTP (`POST /api/admin/capsules/:key/start`).
The admin router calls into the hub (`hub.announceCapsuleStarted`) in the same
process, which loads the new lots' deadlines and broadcasts `CAPSULE_OPENED`
to every connected socket. Resets work the same way. **This is why the REST
API and Socket.IO must be one process**: the hub's timers and per-lot locks
are in memory.

### Scaling constraint

Run **exactly one instance**. Lot deadlines, bid serialisation and the
"advancing" set live in process memory; two instances would each run their own
clocks against the same database. On Render this is the default (one instance
per web service) — just do not enable autoscaling or manual multi-instance
scaling for this service. Sticky sessions are not needed with a single instance.

---

## 8. REST API reference

Every response is JSON. Errors follow one shape the frontend already renders:

```json
{ "status": "error", "message": "Human-readable reason." }
```

Successful mutations return `{ "status": "success", "message": "…" }`, often
with extra fields. HTTP status: `200` success, `400` a rule or validation
rejection, `403` the organiser gate, `404` unknown team/pod, `500` unexpected.

Requests are logged as `[api] METHOD /path` in the server output.

### Health

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{ status: "ok", at }` — use this for Render's health check |
| `GET` | `/api/auction/health` | same, kept for older clients |

### `/api/auction` — event state and team context

| Method | Path | Gate | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/auction/state` | — | Running order and each round's status; `live` is the current round |
| `GET` | `/api/auction/context/:teamIdOrEmail` | — | One team's view: role of the caller (lead / member), the tier open in its pod (`currentLot`), what the team has already secured in the live round (`currentResult`, from `settlements`, null while still bidding), every team in its pod with the tier each ended up with (`podSummary`, for the live round or the one that finished most recently — so a pod's results stay readable after its room closes), capsules with the team's pod for the live one, and its Resource Manager (`resources`: every settlement, `spent`, `remaining`, reserve). The payload is identical for the lead and every member — only `viewerRole` differs. **This is what the frontend's Teams and Bidding pages read.** `404` with an error context when the identity is unknown. |
| `GET` | `/api/auction/teams/:teamIdOrEmail/resources` | — | Just the Resource Manager (budget, spend, reserve, owned tiers) |
| `POST` | `/api/auction/start` | organiser | Prepare the whole event: draw pods for every round. Opens nothing. |
| `POST` | `/api/auction/capsules/:key/start` | organiser | Force one round open, out of order. Development convenience. |
| `POST` | `/api/auction/reset` | organiser | Remove every pod, lot, bid and settlement. Teams stay. |

### `/api/teams` — create, join, look up

| Method | Path | Gate | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/teams/by-email/:email` | — | The team an email belongs to: `{ status: "success", viewerRole, team }`, or `{ status: "idle" }` when it is in none |
| `POST` | `/api/teams/submit` | — | Create or join. Body: `{ intent: "create", teamName, leaderName, email, leaderAccepted: true }` or `{ intent: "join", teamCode, memberName, email }`. Validation errors come back as `200` with `status: "error"` (the form shows the message inline); a missing `intent` is `400`. |
| `GET` | `/api/teams/users` | — | Every user with their team and role. **Development mode only** — production always answers `[]`. Powers the frontend's dev-only "act as" picker. |

Team rules enforced here: one team per email, six members maximum, codes are
`HG-` plus six characters and generated server-side, leadership is the
`leaderId` on the team (a member's role is derived, never stored).

### `/api/admin` — the organiser portal

| Method | Path | Gate | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/admin/context` | — | Everything the admin page shows: team roster, event status, every round with its pods, seats, settled items and **live presence** (`online` per team, from the hub's rooms) |
| `POST` | `/api/admin/event/start` | organiser | Same as `/api/auction/start` |
| `POST` | `/api/admin/event/reset` | organiser | Same as `/api/auction/reset` |
| `POST` | `/api/admin/capsules/:key/start` | organiser | Open the next round (must be the next in order; earlier one closed). Announces `CAPSULE_OPENED` to every socket. |
| `POST` | `/api/admin/capsules/:key/reset` | organiser | Rewind one round to prepared |
| `POST` | `/api/admin/capsules/:key/sub-capsules/:subKey/reset` | organiser | Rewind one tier within a round |
| `POST` | `/api/admin/capsules/:key/pods` | organiser | Create a manual pod. Body `{ podNumber: 13, isRemainder: false }` |
| `POST` | `/api/admin/capsules/:key/pods/:podId/reset` | organiser | Rewind one pod of the live round; the hub restarts its timers |
| `POST` | `/api/admin/capsules/:key/pods/:podId/teams` | organiser | Seat a team. Body `{ teamId: 42 }` |
| `DELETE` | `/api/admin/capsules/:key/pods/:podId/teams/:teamId` | organiser | Unseat a team |
| `PATCH` | `/api/admin/capsules/:key/pods/:podId/remainder` | organiser | Flag / unflag the round's lucky-remainder pod. Body `{ flagged: true }` |
| `DELETE` | `/api/admin/capsules/:key/pods/:podId` | organiser | Delete a manual pod (pending rounds only) |

`:key` is a capsule key from the catalogue: `track-auction`, `ai-rights`,
`ai-capability`, `customer-segment`. `:subKey` is a tier key such as
`developer-tools`.

### Quick examples

```bash
B=https://your-backend.onrender.com

curl $B/health
curl $B/api/auction/state
curl $B/api/auction/context/lead@example.com
curl -X POST $B/api/teams/submit -H 'content-type: application/json' \
     -d '{"intent":"create","teamName":"Nova","leaderName":"Ada","email":"ada@example.com","leaderAccepted":true}'
curl -X POST $B/api/admin/capsules/track-auction/start -H "x-admin-key: $ADMIN_API_KEY"
```

---

## 9. Organiser (admin) authentication

`lib/organiser-auth.mjs` is one gate shared by every route marked *organiser*
above (both `/api/admin/*` mutations and the organiser shortcuts under
`/api/auction`).

| Mode | Rule |
| --- | --- |
| development | open — anyone can press the buttons (this is the local dry-run experience) |
| production, `ADMIN_API_KEY` unset | **closed**: every organiser route answers `403 Organiser controls require server-side admin authentication in production.` |
| production, `ADMIN_API_KEY` set | the request must carry header `x-admin-key: <the same value>`; otherwise `403 Organiser controls require a valid admin key.` |

The key is a bearer secret. Generate a long random one
(`openssl rand -hex 32`), set it on the backend, and set the **same value** as
`ADMIN_API_KEY` on the frontend, where its server actions attach the header.
The frontend never sends the key to the browser. Read-only routes
(`/api/admin/context`, all `GET`s) are not gated, matching the original app.

The application has no server-verifiable user sessions (Firebase sign-in is
client-side only), which is why organiser access is a shared secret rather
than a per-user role.

---

## 10. CORS

The frontend runs on a different origin, so browsers require the backend to
allow it. `CORS_ORIGIN` is a comma-separated list of exact origins
(scheme + host + port, no path, no trailing slash):

```env
CORS_ORIGIN="https://hackgrid.vercel.app,https://hackgrid-git-main-yourteam.vercel.app,http://localhost:3000"
```

Applied to **both** Express (`Access-Control-Allow-Origin`, allowed methods
`GET, POST, PATCH, DELETE, OPTIONS`, allowed headers `Content-Type,
x-admin-key`, credentials on) **and** the Socket.IO handshake (its polling
requests and the WebSocket upgrade are checked against the same list).

- Requests with **no `Origin` header** (curl, the frontend's server actions
  running on Vercel, Render's health check) are always allowed — CORS is a
  browser mechanism.
- Development with `CORS_ORIGIN` unset allows any origin so a local frontend
  on any port works.
- Production with `CORS_ORIGIN` unset allows no browser origin: the API still
  works from the server actions, but the **Socket.IO connection from the
  browser will fail**. Always set it in production.
- Vercel preview deployments have their own origins
  (`https://<project>-<hash>-<team>.vercel.app`). Add the ones you use.

---

## 11. Database

- Schema: `prisma/schema.prisma` (Postgres). Tables: `users`, `teams`,
  `team_members` (the onboarding roster) and the auction tables (events,
  capsules, sub-capsules, pods, pod members, lots, bids, settlements).
- Prisma 7 with the `@prisma/adapter-pg` driver adapter: the server talks to
  Postgres through `pg` with a **fixed pool of 10 connections**, held open
  (`idleTimeoutMillis: 0`, keep-alive) because a serverless-style Postgres
  such as Neon takes ~2 s to open a connection and a quiet minute between
  rounds would otherwise drain the pool.
- Creating the tables: `npm run db:push`. Prisma reads `DATABASE_URL` from
  `.env` or the environment. There are no migration files; `db push` diffs the
  schema against the database. Run it from your machine against the
  production database once (Render's build step does not need to).
- Neon: use the **pooled** connection string (the `-pooler` host) and
  `sslmode=require`. The `pg` driver prints a deprecation notice about
  `sslmode=require` semantics on boot; it is harmless, and `sslmode=verify-full`
  silences it.

---

## 12. Deploying to Render

The backend is a Render **Web Service** (not a Background Worker — it must
accept inbound HTTP and WebSocket traffic). One service runs both the API and
Socket.IO.

### Settings

| Setting | Value |
| --- | --- |
| Type | Web Service |
| Runtime / Language | Node |
| Repository | the repository containing this backend |
| Root Directory | leave blank if this directory *is* the repository; otherwise `backend` |
| Branch | `main` (or whichever you deploy) |
| Build Command | `npm ci` |
| Start Command | `npm start` |
| Health Check Path | `/health` |
| Instance count | **1** (see [§7 scaling constraint](#scaling-constraint)) |
| Plan | any; note that the free plan spins down (below) |

`npm ci` installs from `package-lock.json` and runs `prisma generate` through
`postinstall`, so the Prisma client is built during the build step. If you
prefer an explicit build, `npm ci && npm run build` is equivalent.

### Environment variables (Render → Environment)

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24` (or `20`+; Render's default is fine if ≥ 20.12) |
| `DATABASE_URL` | your production Postgres URL |
| `CORS_ORIGIN` | `https://<your-frontend>.vercel.app` (comma-separate previews) |
| `ADMIN_API_KEY` | a long random secret (omit to keep organiser routes closed) |
| `HACKGRID_*_SECONDS` | only if you want non-default timings |

Do **not** set `PORT` or `HOST` — Render injects `PORT` and the server binds
`0.0.0.0` by default.

### Blueprint

A `render.yaml` at the root of this directory describes the same service, so
**New → Blueprint** in the Render dashboard can create it from the repository.
Secrets marked `sync: false` are prompted for in the dashboard.

### Port

Render sets `PORT` and routes traffic to it; `server.mjs` reads
`process.env.PORT`. The service must bind `0.0.0.0` (default here). Render
terminates TLS, so the public URL is `https://…` and sockets are `wss://…`;
inside, the process sees plain HTTP with `X-Forwarded-*` headers
(`app.set("trust proxy", 1)` is on).

### WebSockets on Render

- Render web services support WebSockets natively; **no extra configuration**
  is needed for `/socket.io`. The HTTP upgrade goes through Render's proxy.
- The Socket.IO client is configured for `["websocket", "polling"]` so if an
  intermediary ever blocks the upgrade it falls back to long-polling on the
  same path — both must be allowed by `CORS_ORIGIN`, which they are.
- **Free plan spin-down**: a free service sleeps after ~15 minutes without
  traffic and takes 30–60 s to wake. The first request (or socket connect)
  after sleep will look hung and sockets will retry. For a live event, use a
  paid plan or keep the service warm (e.g. an uptime pinger hitting `/health`
  every 5 minutes). Sleeping also drops all sockets and the in-memory timers;
  on wake, `hub.hydrate()` reloads open-lot deadlines from the database.
- **Deploys restart the process**, which disconnects every socket. Socket.IO
  clients reconnect automatically and re-join their room; `hydrate()` restores
  timers. Avoid deploying in the middle of a round anyway.
- Keep it at **one instance** — multiple instances would each run their own
  lot timers.
- Render's proxy has an idle timeout on open connections; Socket.IO's
  heartbeat (`pingInterval` 25 s by default) keeps sockets under it.

### Database on Render

Use any Postgres reachable from Render: Render Postgres (set `DATABASE_URL`
to its *internal* URL if the database is in the same region for lower
latency), Neon, Supabase, etc. Run `npm run db:push` **from your machine**
with `DATABASE_URL` pointed at the production database before the first
deploy.

---

## 13. Verifying a deployment

With `B` set to the service URL:

```bash
B=https://your-backend.onrender.com

# 1. Alive and in the right mode (check the Render logs for the boot summary:
#    mode, CORS list, organiser-gate state)
curl -i $B/health

# 2. Database reachable
curl $B/api/auction/state

# 3. CORS for the frontend origin — expect Access-Control-Allow-Origin back
curl -i -H "Origin: https://your-frontend.vercel.app" $B/health | grep -i access-control

# 4. Socket.IO handshake reachable (polling) — expect HTTP 200 and a 0{...} payload
curl -i -H "Origin: https://your-frontend.vercel.app" "$B/socket.io/?EIO=4&transport=polling"

# 5. Organiser gate — expect 403 without the key, 200/400 with it
curl -i -X POST $B/api/admin/event/start
curl -i -X POST $B/api/admin/event/start -H "x-admin-key: $ADMIN_API_KEY"

# 6. A real WebSocket (needs a lead's email, their team id and their pod id from /api/admin/context)
npx wscat -c "wss://your-backend.onrender.com/socket.io/?EIO=4&transport=websocket"
```

Then open the deployed frontend: the Teams page should show your team (that is
`/api/teams/by-email` and `/api/auction/context`), and the Bidding page as a
team lead should show "Connected to room …" in its console panel (that is the
socket). The Render logs show `[auction] join pod=… team=…` for each seat.

---

## 14. Operational notes

- **Logs**: `[api] METHOD /path` per API request, `[auction] …` for room
  activity, `[socket] …` for socket failures, `[server] …` for lifecycle.
- **Graceful shutdown**: `SIGTERM` closes Socket.IO and the HTTP server, then
  exits (5 s hard limit).
- **Presence** for the admin page comes from live socket rooms
  (`hub.onlineTeamsByPod()`), so it is only accurate for the running instance
  — another reason for one instance.
- **Timings** can be shortened with the `HACKGRID_*_SECONDS` variables to dry
  run a whole event in minutes. Restart the server after changing them.
- **Shared contract files**: `lib/auction-catalog.mjs` (capsules, tiers,
  prices) and `lib/auction-rules.mjs` (timings, rejection codes) are copied
  verbatim into the frontend (`frontend/lib/`) so the UI can render them
  without a round trip. If you change either here, change the frontend's copy
  too.

---

## 15. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `[server] DATABASE_URL is not set.` on boot | Add it to `.env` or the host's environment. |
| `Can't reach database server` | Wrong URL, database asleep, or no network from the host. On Neon use the pooled host and `sslmode=require`. |
| Browser: CORS error, or the socket never connects from the deployed frontend | `CORS_ORIGIN` does not contain the frontend's exact origin (check for a trailing slash, `http` vs `https`, a preview URL). The boot summary prints the list. |
| `403 Organiser controls require …` from the admin page in production | Set `ADMIN_API_KEY` on **both** the backend and the frontend to the same value and redeploy both. |
| Admin page works locally but the "act as" picker is empty | The roster only exists when the **backend** runs in development mode. |
| First request after idle takes ~1 minute | Render free-plan spin-down. Use a paid plan or a keep-alive pinger during events. |
| Two sockets from one team, or timers firing twice | More than one instance is running. Scale to one. |
| `prisma generate` fails during `npm install` | The install did not need a database, but it does need the `prisma` package; make sure dev dependencies are not being pruned (`prisma` is in `dependencies` here for that reason). |
