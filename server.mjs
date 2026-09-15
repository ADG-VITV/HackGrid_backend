/**
 * HackGrid backend: Express and Socket.IO on one port.
 *
 * Layout:
 *   express app   -> /api/auction/*  the auction REST API   (lib/auction-router.mjs)
 *                 -> /api/teams/*    create / join / lookup (lib/teams-router.mjs)
 *                 -> /api/admin/*    organiser controls     (lib/admin-router.mjs)
 *                 -> /health         liveness probe for the host
 *   http.Server   -> shared by Express and Socket.IO
 *   socket.io     -> /socket.io      the live bidding rooms (lib/auction-hub.mjs)
 *
 * The Next.js frontend is a separate application on a separate origin. It
 * talks to this server over HTTPS (the REST routes) and WebSocket (Socket.IO),
 * so CORS is configured from CORS_ORIGIN.
 *
 * There is no build step: this is plain Node, started with `node server.mjs`.
 * The Socket.IO server is created in this file and attached to the same
 * http.Server Express listens on — it is not a second process.
 */

import { createServer } from "node:http";
import { loadEnvFile } from "node:process";
import cors from "cors";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { createAdminRouter } from "./lib/admin-router.mjs";
import { createAuctionHub } from "./lib/auction-hub.mjs";
import { createAuctionRouter } from "./lib/auction-router.mjs";
import { JUDGE_RESULTS_KEY_HEADER, judgeAuthConfigured } from "./lib/judge-auth.mjs";
import { createJudgeRouter } from "./lib/judge-router.mjs";
import { ADMIN_KEY_HEADER, createOrganiserGate } from "./lib/organiser-auth.mjs";
import { createTeamsRouter } from "./lib/teams-router.mjs";

try {
  loadEnvFile();
} catch {
  // Fine — the host may inject DATABASE_URL directly.
}

const port = parseInt(process.env.PORT || "4000", 10);
// Bind to every interface by default so a container host (Render) can reach
// the process; HOST=localhost keeps a dev run private to the machine.
const host = process.env.HOST || "0.0.0.0";

// Which mode to run in. An explicit NODE_ENV wins; otherwise `npm run dev` is
// development and everything else (`npm start`, a bare `node server.mjs`, a
// host's start command) is production. npm sets npm_lifecycle_event to the
// script name, so this works the same in PowerShell, cmd and sh.
const dev = process.env.NODE_ENV
  ? process.env.NODE_ENV !== "production"
  : process.env.npm_lifecycle_event === "dev";
// Prisma and the engine's own NODE_ENV checks read this, so make sure they
// see the mode this server actually decided on.
process.env.NODE_ENV = dev ? "development" : "production";

// Production may point at its own database. Only honoured in production, so a
// dev run can never touch the live tables by accident.
if (!dev && process.env.DATABASE_URL_PRODUCTION) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_PRODUCTION;
}

if (!process.env.DATABASE_URL) {
  console.error("[server] DATABASE_URL is not set. Add it to .env before starting.");
  process.exit(1);
}

/**
 * Origins allowed to call the API and open sockets: a comma-separated list in
 * CORS_ORIGIN. Unset in development means "any origin", so a local frontend on
 * any port just works; unset in production means no browser origin is allowed
 * (server-to-server calls, which carry no Origin header, still are).
 */
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // curl, server actions, health checks
  if (allowedOrigins.length === 0) return dev;
  return allowedOrigins.includes(origin.replace(/\/+$/, ""));
}

const corsOptions = {
  origin(origin, callback) {
    callback(null, isAllowedOrigin(origin));
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", ADMIN_KEY_HEADER, JUDGE_RESULTS_KEY_HEADER],
  credentials: true,
};

// --------------------------------------------------------------------- setup

const app = express();
const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  path: "/socket.io",
  serveClient: false,
  cors: corsOptions,
});

const hub = createAuctionHub({ connectionString: process.env.DATABASE_URL, io });
const { organiserOnly, isOrganiser, adminKeyConfigured } = createOrganiserGate({ dev });

// ----------------------------------------------------------------- middleware

app.disable("x-powered-by");
// Render terminates TLS in front of the service, so the request's protocol and
// client address arrive in X-Forwarded-* headers.
app.set("trust proxy", 1);
app.use(cors(corsOptions));
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", at: new Date().toISOString() });
});

app.use("/api", (req, _res, nextFn) => {
  console.log(`[api] ${req.method} ${req.originalUrl}`);
  nextFn();
});

app.use("/api/auction", createAuctionRouter({ prisma: hub.prisma, hub, organiserOnly }));
app.use("/api/teams", createTeamsRouter({ prisma: hub.prisma, dev }));
app.use("/api/admin", createAdminRouter({ prisma: hub.prisma, hub, organiserOnly }));
app.use("/api/judge", createJudgeRouter({ prisma: hub.prisma, isOrganiser }));

app.use((_req, res) => {
  res.status(404).json({ status: "error", message: "Not found." });
});

// Express error handler. Express identifies it by its arity, so the fourth
// argument has to stay even though nothing calls it.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _nextFn) => {
  // Malformed JSON from the client is a 400, not a server fault.
  if (error?.type === "entity.parse.failed") {
    return res.status(400).json({ status: "error", message: "Malformed JSON body." });
  }
  console.error("[api] unhandled:", error);
  if (res.headersSent) return;
  res.status(500).json({ status: "error", message: "Internal server error" });
});

// ------------------------------------------------------------------ socket.io

/**
 * Identity arrives in the handshake. It is checked here before the connection
 * is accepted, so a socket that reaches the connection handler is already known
 * to belong to the pod it claims.
 */
io.use((socket, nextFn) => {
  const { podId, teamId, email } = socket.handshake.auth ?? {};
  const parsedTeamId = Number.parseInt(teamId, 10);

  if (typeof podId !== "string" || !podId || !Number.isInteger(parsedTeamId)) {
    return nextFn(new Error("Missing or invalid podId / teamId."));
  }
  // Only the team lead bids (rulebook 8), so the room needs to know who is
  // asking, not just which team they are on.
  if (typeof email !== "string" || !email.includes("@")) {
    return nextFn(new Error("Missing the signed-in email."));
  }

  socket.data.requestedPodId = podId;
  socket.data.requestedTeamId = parsedTeamId;
  socket.data.requestedEmail = email.trim().toLowerCase();
  nextFn();
});

io.on("connection", async (socket) => {
  const podId = socket.data.requestedPodId;
  const teamId = socket.data.requestedTeamId;
  const email = socket.data.requestedEmail;

  let seated = false;
  try {
    seated = await hub.attach(socket, { podId, teamId, email });
  } catch (error) {
    console.error("[socket] attach failed:", error);
    socket.emit("ROOM_ERROR", { message: "Could not join the room." });
  }

  if (!seated) {
    socket.disconnect(true);
    return;
  }

  socket.on("SYNC", () => {
    hub
      .pushRoomState(podId, { only: socket })
      .catch((error) => console.error("[socket] sync failed:", error));
  });

  socket.on("BID", async (payload, ack) => {
    // Nothing from the client is trusted past this point — the amount is
    // parsed as an integer and the hub decides whether it is legal.
    const lotId = String(payload?.lotId ?? "");
    const amount = Number.parseInt(payload?.amount, 10);

    try {
      const result = await hub.handleBid(socket, { lotId, amount });
      if (typeof ack === "function") ack(result);
    } catch (error) {
      console.error("[socket] bid failed:", error);
      if (typeof ack === "function") {
        ack({
          ok: false,
          lotId,
          code: "UNKNOWN",
          reason: "Server could not record that bid. Try again.",
        });
      }
    }
  });

  socket.on("disconnect", () => {
    hub.detach(socket).catch((error) => console.error("[socket] detach failed:", error));
  });
});

// ------------------------------------------------------------------- listen

await hub.hydrate().catch((error) => console.error("[server] hydrate failed:", error));

httpServer.listen(port, host, () => {
  const shown = host === "0.0.0.0" ? "localhost" : host;
  console.log(`> HackGrid backend ready on http://${shown}:${port} (${process.env.NODE_ENV})`);
  console.log(`> REST API        http://${shown}:${port}/api/{auction,teams,admin,judge}`);
  console.log(`> Socket.IO       ws://${shown}:${port}/socket.io`);
  console.log(
    `> CORS            ${allowedOrigins.length ? allowedOrigins.join(", ") : dev ? "any origin (development)" : "no browser origins (set CORS_ORIGIN)"}`,
  );
  console.log(
    `> Organiser API   ${dev ? "open (development)" : adminKeyConfigured ? "x-admin-key required" : "disabled (set ADMIN_API_KEY to enable)"}`,
  );
  console.log(
    `> Judge portal    ${judgeAuthConfigured() ? "Firebase ID tokens verified" : "disabled (set FIREBASE_PROJECT_ID to enable /api/judge)"}`,
  );
});

// Let the host stop the process cleanly on a redeploy.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`[server] ${signal} received, shutting down`);
    io.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
