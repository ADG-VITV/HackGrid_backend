/**
 * The auction hub: one Socket.IO room per pod.
 *
 * Runs inside the Express server (server.mjs). The admin router in the same
 * process calls into it directly to announce that pods were just created.
 *
 * Every rule decision in here happens on the server. The browser sends an
 * intent ("bid 380 on this lot") and nothing more; this file decides whether
 * that is legal, writes it to Postgres, and tells the room what happened.
 *
 * Room membership is Socket.IO's own: socket.join(podId) puts a client in a
 * room and io.to(podId).emit(...) reaches everyone in it, so there is no
 * connection bookkeeping here.
 */

import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  BID_TIMEOUT_SECONDS,
  REMAINDER_PICK_SECONDS,
  STARTING_BALANCE,
  SUBCAPSULE_SECONDS,
  computeClosesAt,
  nextMinBid,
  quorumFor,
  spendingCapFor,
  validateBid,
} from "./auction-rules.mjs";
import { reserveAfter } from "./auction-catalog.mjs";
import {
  closeCapsuleIfDone,
  mainPodsFinished,
  openRemainderPod,
} from "./auction-engine.mjs";

const TICK_MS = 1000;
/** Opening a connection to Neon costs ~2s, so a fixed pool is opened up front. */
const POOL_SIZE = 10;
/** How many lots may settle at once, so a wave of closures can't hog the pool. */
const CLOSE_CONCURRENCY = 3;

function log(...args) {
  console.log("[auction]", ...args);
}

export function createAuctionHub({ connectionString, io }) {
  const adapter = new PrismaPg({
    connectionString,
    max: POOL_SIZE,
    // node-postgres closes idle connections after 10s by default, so a quiet
    // minute between rounds drains the pool and the next team to arrive pays
    // the full ~2s Neon handshake again. Hold them open for the whole event.
    idleTimeoutMillis: 0,
    keepAlive: true,
  });
  // One client for the whole process: the REST routers borrow it from the hub
  // so there is a single connection pool rather than several competing ones.
  const prisma = new PrismaClient({ adapter });

  /** Pods with at least one client, so empty rooms are never pushed to. */
  const occupiedPods = new Set();
  /** podId -> in-flight snapshot, so a burst of joins costs one read, not five */
  const inflightSnapshots = new Map();
  /** lotId -> { podId, closesAt: number } — in memory so the tick costs no queries */
  const deadlines = new Map();
  /** lotId -> Promise, serialises bids per lot inside this process */
  const lotQueues = new Map();
  /** podId -> Promise, serialises no-bid assignments so a team can't be handed two tiers */
  const podQueues = new Map();
  /** capsuleIds currently being advanced, so two lots closing at once don't both chain */
  const advancing = new Set();

  let ticking = null;

  // ---------------------------------------------------------------- helpers

  /** Everyone in the pod. Pass `except` to skip the socket that caused it. */
  function broadcast(podId, event, payload, { except } = {}) {
    const target = except ? except.to(podId) : io.to(podId);
    target.emit(event, payload);
  }

  /** Every connected client, whichever room they are in. */
  function broadcastAll(event, payload) {
    io.emit(event, payload);
  }

  function devLog(podId, message, level = "info") {
    broadcast(podId, "LOG", { level, message, at: new Date().toISOString() });
  }

  /** Team ids currently connected to a pod, straight from Socket.IO. */
  async function onlineTeamIds(podId) {
    const sockets = await io.in(podId).fetchSockets();
    return new Set(sockets.map((s) => s.data.teamId).filter((id) => typeof id === "number"));
  }

  /**
   * podId -> Set of team ids connected to it, for every pod at once. The
   * organiser view wants presence for every pod on the page, and one pass
   * over all sockets is cheaper than asking Socket.IO room by room.
   */
  async function onlineTeamsByPod() {
    const sockets = await io.fetchSockets();
    const byPod = new Map();
    for (const s of sockets) {
      const { podId, teamId } = s.data;
      // A socket mid-handshake has no seat yet; attach() sets both together.
      if (typeof podId !== "string" || typeof teamId !== "number") continue;
      if (!byPod.has(podId)) byPod.set(podId, new Set());
      byPod.get(podId).add(teamId);
    }
    return byPod;
  }

  /** Run `fn` with exclusive access to a lot, so two bids can't interleave. */
  function withLotLock(lotId, fn) {
    const previous = lotQueues.get(lotId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    lotQueues.set(
      lotId,
      next.then(
        () => {
          if (lotQueues.get(lotId) === next) lotQueues.delete(lotId);
        },
        () => {
          if (lotQueues.get(lotId) === next) lotQueues.delete(lotId);
        },
      ),
    );
    return next;
  }

  /** Like withLotLock, but for decisions that read the whole pod's ledger. */
  function withPodLock(podId, fn) {
    const previous = podQueues.get(podId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    podQueues.set(
      podId,
      next.then(
        () => {
          if (podQueues.get(podId) === next) podQueues.delete(podId);
        },
        () => {
          if (podQueues.get(podId) === next) podQueues.delete(podId);
        },
      ),
    );
    return next;
  }

  /**
   * Nobody bid on a tier in its whole window. Rather than leave it unsold —
   * which would leave one team with nothing — hand it to a team in the pod
   * that still has no tier, chosen at random, at the price it opened at.
   *
   * Returns the settlement details, or null if every team already has a tier.
   */
  async function assignUnbidLot(lot) {
    const podId = lot.pod.id;
    return withPodLock(podId, async () => {
      const [memberships, settled] = await Promise.all([
        prisma.podMembership.findMany({ where: { podId }, orderBy: { seat: "asc" } }),
        prisma.settlement.findMany({
          where: { lot: { podId } },
          select: { teamId: true },
        }),
      ]);

      const taken = new Set(settled.map((row) => row.teamId));
      const eligible = memberships.filter((m) => !taken.has(m.teamId));
      if (eligible.length === 0) return null;

      const winner = eligible[randomInt(eligible.length)];
      const isRemainder = lot.pod.kind === "REMAINDER";
      const pricePaid = isRemainder ? (lot.frozenPrice ?? lot.subCapsule.startingBid) : lot.subCapsule.startingBid;

      await prisma.$transaction([
        prisma.lot.update({ where: { id: lot.id }, data: { status: "CLOSED" } }),
        prisma.settlement.create({
          data: {
            lotId: lot.id,
            capsuleId: lot.pod.capsuleId,
            subCapsuleId: lot.subCapsuleId,
            teamId: winner.teamId,
            pricePaid,
            priceSource: "NO_BIDS_ASSIGNED",
          },
        }),
      ]);

      return { winner, pricePaid };
    });
  }

  // ------------------------------------------------------------- room state

  async function loadPodSnapshot(podId) {
    // Two queries, issued together. `relationLoadStrategy: "join"` folds the
    // whole include tree into one statement, and the settlement lookup is
    // expressed against the pod so it doesn't have to wait for the first
    // result. Only the top bid is fetched — the rest of the log is never read
    // here, only counted.
    const [pod, settlements] = await Promise.all([
      prisma.pod.findUnique({
        where: { id: podId },
        relationLoadStrategy: "join",
        include: {
          capsule: { include: { subCapsules: { select: { id: true } } } },
          memberships: { orderBy: { seat: "asc" } },
          lots: {
            orderBy: { tierRank: "asc" },
            include: {
              subCapsule: true,
              settlement: true,
              bids: { orderBy: [{ amount: "desc" }, { createdAt: "asc" }], take: 1 },
              _count: { select: { bids: true } },
            },
          },
        },
      }),
      prisma.settlement.findMany({
        where: { team: { podMemberships: { some: { podId } } } },
        select: { teamId: true, pricePaid: true, capsuleId: true, lotId: true },
      }),
    ]);

    if (!pod) return null;

    const teamNameById = new Map(pod.memberships.map((m) => [m.teamId, m.teamName]));
    const online = await onlineTeamIds(podId);

    const isRemainderPod = pod.kind === "REMAINDER";
    // n is the pod's own seat count, so the remainder pod uses its real size.
    const podSize = pod.memberships.length;
    const quorum = quorumFor(podSize);
    const onlineCount = online.size;

    const lots = pod.lots.map((lot) => {
      const topBid = lot.bids[0] ?? null;
      const sc = lot.subCapsule;
      // A remainder-pod tier opens at its frozen average rather than the listed
      // starting bid, and raises on it only decide who wins (rulebook 7).
      const entryPrice = isRemainderPod ? (lot.frozenPrice ?? sc.startingBid) : sc.startingBid;
      return {
        id: lot.id,
        subCapsuleId: sc.id,
        subCapsuleKey: sc.key,
        name: sc.name,
        tierRank: lot.tierRank,
        status: lot.status,
        startingBid: entryPrice,
        listedPrice: sc.startingBid,
        frozenPrice: isRemainderPod ? lot.frozenPrice : null,
        minIncrement: sc.minIncrement,
        isAutoAssigned: isRemainderPod ? false : sc.isAutoAssigned,
        openedAt: lot.openedAt ? lot.openedAt.toISOString() : null,
        closesAt: lot.closesAt ? lot.closesAt.toISOString() : null,
        // OPEN but with no deadline means the pod has not filled up yet.
        awaitingQuorum: lot.status === "OPEN" && lot.closesAt === null,
        nextMin: nextMinBid({
          startingBid: entryPrice,
          minIncrement: sc.minIncrement,
          topAmount: topBid ? topBid.amount : null,
        }),
        bidCount: lot._count.bids,
        top: topBid
          ? {
              teamId: topBid.teamId,
              teamName: teamNameById.get(topBid.teamId) ?? "Unknown team",
              amount: topBid.amount,
              at: topBid.createdAt.toISOString(),
            }
          : null,
        result: lot.settlement
          ? {
              teamId: lot.settlement.teamId,
              teamName: teamNameById.get(lot.settlement.teamId) ?? "Unknown team",
              pricePaid: lot.settlement.pricePaid,
              priceSource: lot.settlement.priceSource,
            }
          : null,
      };
    });

    const spentByTeam = new Map();
    for (const s of settlements) {
      spentByTeam.set(s.teamId, (spentByTeam.get(s.teamId) ?? 0) + s.pricePaid);
    }
    const wonLotByTeam = new Map();
    for (const s of settlements) {
      if (s.capsuleId === pod.capsuleId) wonLotByTeam.set(s.teamId, s.lotId);
    }

    return {
      pod,
      spentByTeam,
      wonLotByTeam,
      shared: {
        serverTime: new Date().toISOString(),
        pod: {
          id: pod.id,
          label: pod.label,
          kind: pod.kind,
          capsuleId: pod.capsuleId,
          capsuleKey: pod.capsule.key,
          capsuleName: pod.capsule.name,
          podSize,
          quorum,
          onlineCount,
        },
        members: pod.memberships.map((m) => ({
          teamId: m.teamId,
          teamName: m.teamName,
          teamCode: m.teamCode,
          leadName: m.leadName,
          leadEmail: m.leadEmail,
          seat: m.seat,
          online: online.has(m.teamId),
        })),
        lots,
      },
    };
  }

  function personalise(snapshot, teamId) {
    const member = snapshot.shared.members.find((m) => m.teamId === teamId);
    const remainingBalance = STARTING_BALANCE - (snapshot.spentByTeam.get(teamId) ?? 0);
    const reserve = reserveAfter(snapshot.shared.pod.capsuleKey);
    return {
      ...snapshot.shared,
      you: {
        teamId,
        teamName: member ? member.teamName : "Spectator",
        remainingBalance,
        reserve,
        spendingCap: spendingCapFor({ remainingBalance, reserve }),
        wonLotId: snapshot.wonLotByTeam.get(teamId) ?? null,
      },
    };
  }

  /**
   * Collapse overlapping reads of the same pod. Five teams joining a room at
   * once would otherwise each pay for their own snapshot; they now share one.
   */
  function loadPodSnapshotShared(podId) {
    const existing = inflightSnapshots.get(podId);
    if (existing) return existing;

    const pending = loadPodSnapshot(podId).finally(() => {
      if (inflightSnapshots.get(podId) === pending) inflightSnapshots.delete(podId);
    });
    inflightSnapshots.set(podId, pending);
    return pending;
  }

  /**
   * Start the clock on any open-but-unstarted lot in a pod, once enough of its
   * teams are connected. Called when someone joins and whenever a lot opens.
   *
   * The gate is on starting only: once a tier is running it keeps running, so
   * one team dropping out mid-tier cannot freeze the round.
   */
  async function maybeStartTimers(podId) {
    const [memberships, waiting, online] = await Promise.all([
      prisma.podMembership.count({ where: { podId } }),
      prisma.lot.findMany({
        where: { podId, status: "OPEN", closesAt: null },
        relationLoadStrategy: "join",
        include: { subCapsule: { select: { name: true } } },
      }),
      onlineTeamIds(podId),
    ]);

    if (waiting.length === 0) return false;

    const quorum = quorumFor(memberships);
    if (online.size < quorum) return false;

    const openedAt = new Date();
    const closesAt = computeClosesAt({ openedAt, lastBidAt: null });

    await prisma.lot.updateMany({
      where: { id: { in: waiting.map((lot) => lot.id) } },
      data: { openedAt, closesAt },
    });

    for (const lot of waiting) {
      deadlines.set(lot.id, { podId, closesAt: closesAt.getTime() });
      broadcast(podId, "LOT_OPENED", {
        lotId: lot.id,
        name: lot.subCapsule.name,
        closesAt: closesAt.toISOString(),
      });
    }

    devLog(
      podId,
      `${online.size} of ${memberships} teams are here — the clock is running (${waiting.length} tier(s) open).`,
    );
    ensureTicking();
    await pushRoomState(podId);
    return true;
  }

  async function pushRoomState(podId, { only } = {}) {
    const snapshot = await loadPodSnapshotShared(podId);
    if (!snapshot) return;

    // Keep the in-memory deadlines aligned with whatever the DB now says.
    for (const lot of snapshot.shared.lots) {
      if (lot.status === "OPEN" && lot.closesAt) {
        deadlines.set(lot.id, { podId, closesAt: new Date(lot.closesAt).getTime() });
      } else {
        deadlines.delete(lot.id);
      }
    }

    // Every client sees the same room but a different `you`, so the payload is
    // built per socket rather than broadcast once to the whole room.
    const targets = only ? [only] : await io.in(podId).fetchSockets();
    for (const socket of targets) {
      const teamId = socket.data?.teamId;
      if (typeof teamId !== "number") continue;
      socket.emit("ROOM_STATE", personalise(snapshot, teamId));
    }
  }

  // ------------------------------------------------------------- lot lifecycle

  /** Open the lowest-ranked PENDING lot in a pod, if the pod has one left. */
  async function openNextLot(podId) {
    const next = await prisma.lot.findFirst({
      where: { podId, status: "PENDING" },
      orderBy: { tierRank: "asc" },
      include: { subCapsule: true },
    });

    if (!next) {
      devLog(podId, "All tiers in this pod are settled.", "info");
      broadcast(podId, "POD_COMPLETE", { podId });
      return null;
    }

    // The last tier is never bid on — it goes to whoever is still unassigned
    // in this pod, at the listed price (rulebook 6.6).
    if (next.subCapsule.isAutoAssigned) {
      await autoAssign(podId, next);
      return openNextLot(podId);
    }

    // Opened, but not yet running: maybeStartTimers decides when the clock
    // begins, based on how much of the pod has turned up.
    await prisma.lot.update({
      where: { id: next.id },
      data: { status: "OPEN", openedAt: null, closesAt: null },
    });

    devLog(
      podId,
      `"${next.subCapsule.name}" is up at ${next.subCapsule.startingBid} credits — ${SUBCAPSULE_SECONDS}s window, ${BID_TIMEOUT_SECONDS}s after each bid.`,
    );

    const started = await maybeStartTimers(podId);
    if (!started) {
      devLog(podId, "Waiting for the pod to fill before the clock starts.", "warn");
      await pushRoomState(podId);
    }
    return next.id;
  }

  /** Hand the auto-assigned tier to the one team left with nothing. */
  async function autoAssign(podId, lot) {
    const [memberships, settled] = await Promise.all([
      prisma.podMembership.findMany({ where: { podId }, orderBy: { seat: "asc" } }),
      prisma.settlement.findMany({
        where: { lot: { podId } },
        select: { teamId: true },
      }),
    ]);

    const taken = new Set(settled.map((s) => s.teamId));
    const remaining = memberships.filter((m) => !taken.has(m.teamId));

    if (remaining.length === 0) {
      await prisma.lot.update({ where: { id: lot.id }, data: { status: "CLOSED" } });
      devLog(podId, `"${lot.subCapsule.name}" has no team left to take it.`, "warn");
      return;
    }

    // Exactly one team left is the rulebook case. More than one should not
    // happen now that unbid tiers are handed out too, but if it does, the tier
    // still goes to someone rather than nobody.
    const winner = remaining.length === 1 ? remaining[0] : remaining[randomInt(remaining.length)];
    const priceSource = remaining.length === 1 ? "AUTO_ASSIGNED" : "NO_BIDS_ASSIGNED";
    const pod = await prisma.pod.findUnique({ where: { id: podId }, select: { capsuleId: true } });

    await prisma.$transaction([
      prisma.lot.update({
        where: { id: lot.id },
        data: { status: "CLOSED", openedAt: new Date(), closesAt: new Date() },
      }),
      prisma.settlement.create({
        data: {
          lotId: lot.id,
          capsuleId: pod.capsuleId,
          subCapsuleId: lot.subCapsuleId,
          teamId: winner.teamId,
          pricePaid: lot.subCapsule.startingBid,
          priceSource,
        },
      }),
    ]);

    deadlines.delete(lot.id);
    broadcast(podId, "LOT_CLOSED", {
      lotId: lot.id,
      name: lot.subCapsule.name,
      winnerTeamId: winner.teamId,
      winnerTeamName: winner.teamName,
      pricePaid: lot.subCapsule.startingBid,
    });
    devLog(
      podId,
      `"${lot.subCapsule.name}" auto-assigned to ${winner.teamName} at ${lot.subCapsule.startingBid} credits (no bidding, rulebook 6.6).`,
    );
  }

  /** Close an expired lot, settle it, then open the next tier. */
  async function closeLot(lotId) {
    return withLotLock(lotId, async () => {
      const lot = await prisma.lot.findUnique({
        where: { id: lotId },
        relationLoadStrategy: "join",
        include: {
          subCapsule: true,
          pod: { select: { id: true, capsuleId: true, kind: true } },
          bids: { orderBy: [{ amount: "desc" }, { createdAt: "asc" }], take: 1 },
        },
      });

      if (!lot || lot.status !== "OPEN") {
        deadlines.delete(lotId);
        return;
      }

      const podId = lot.pod.id;
      const isRemainder = lot.pod.kind === "REMAINDER";
      const topBid = lot.bids[0] ?? null;

      if (!topBid) {
        // Nobody bid inside the window. Hand it to a team that still has
        // nothing, so the tier isn't wasted and nobody leaves empty-handed.
        const assigned = await assignUnbidLot(lot);
        deadlines.delete(lotId);

        if (assigned) {
          broadcast(podId, "LOT_CLOSED", {
            lotId,
            name: lot.subCapsule.name,
            winnerTeamId: assigned.winner.teamId,
            winnerTeamName: assigned.winner.teamName,
            pricePaid: assigned.pricePaid,
          });
          devLog(
            podId,
            `No bids on "${lot.subCapsule.name}" in the window — assigned to ${assigned.winner.teamName} at ${assigned.pricePaid} credits.`,
            "warn",
          );
        } else {
          // Every team already has a tier; nothing left to give this one to.
          await prisma.lot.update({ where: { id: lotId }, data: { status: "CLOSED" } });
          broadcast(podId, "LOT_CLOSED", {
            lotId,
            name: lot.subCapsule.name,
            winnerTeamId: null,
            winnerTeamName: null,
            pricePaid: null,
          });
          devLog(podId, `"${lot.subCapsule.name}" closed with no bids and no team left to take it.`, "warn");
        }

        if (!isRemainder) await openNextLot(podId);
        await afterLotSettled(lot.pod.capsuleId);
        return;
      }

      const membership = await prisma.podMembership.findUnique({
        where: { podId_teamId: { podId, teamId: topBid.teamId } },
      });

      // In the remainder pod a bid only decides who wins; the price was frozen
      // from the main pods average before the pod opened (rulebook 7).
      const pricePaid = isRemainder
        ? (lot.frozenPrice ?? lot.subCapsule.startingBid)
        : topBid.amount;
      const priceSource = isRemainder
        ? await remainderPriceSource(lot.pod.capsuleId, lot.subCapsuleId)
        : "COMPETITIVE";

      await prisma.$transaction([
        prisma.lot.update({ where: { id: lotId }, data: { status: "CLOSED" } }),
        prisma.settlement.create({
          data: {
            lotId,
            capsuleId: lot.pod.capsuleId,
            subCapsuleId: lot.subCapsuleId,
            teamId: topBid.teamId,
            pricePaid,
            priceSource,
            winningBidId: topBid.id,
          },
        }),
      ]);

      deadlines.delete(lotId);
      broadcast(podId, "LOT_CLOSED", {
        lotId,
        name: lot.subCapsule.name,
        winnerTeamId: topBid.teamId,
        winnerTeamName: membership?.teamName ?? "Unknown team",
        pricePaid,
      });
      devLog(
        podId,
        isRemainder
          ? `"${lot.subCapsule.name}" claimed by ${membership?.teamName ?? topBid.teamId} at the frozen price of ${pricePaid} credits.`
          : `"${lot.subCapsule.name}" sold to ${membership?.teamName ?? topBid.teamId} for ${pricePaid} credits.`,
      );

      if (!isRemainder) await openNextLot(podId);
      await afterLotSettled(lot.pod.capsuleId);
    });
  }

  /** Which of the two rulebook-7 prices a remainder-pod settlement used. */
  async function remainderPriceSource(capsuleId, subCapsuleId) {
    const row = await prisma.roundTierPrice.findUnique({
      where: { capsuleId_subCapsuleId: { capsuleId, subCapsuleId } },
      select: { source: true },
    });
    return row?.source ?? "POD_AVERAGE";
  }

  /**
   * Drive the round forward after any lot settles.
   *
   * Two gates. Once the main pods are done the remainder pod can be priced from
   * their averages and opened. Once everything including the remainder pod is
   * settled the capsule closes and waits for the organiser to start the next
   * prepared round.
   */
  async function afterLotSettled(capsuleId) {
    if (advancing.has(capsuleId)) return;
    advancing.add(capsuleId);
    try {
      if (await mainPodsFinished(prisma, capsuleId)) {
        const pendingRemainder = await prisma.lot.count({
          where: { pod: { capsuleId, kind: "REMAINDER" }, status: "PENDING" },
        });

        if (pendingRemainder > 0) {
          const opened = await openRemainderPod(prisma, capsuleId);
          if (opened) {
            await Promise.all(
              opened.podIds.map(async (podId) => {
                devLog(
                  podId,
                  `Main pods are finished. Every tier is open at its frozen price - claim one within ${REMAINDER_PICK_SECONDS}s. A bid here only decides who wins; the price does not move.`,
                );
                const startedRemainder = await maybeStartTimers(podId);
                if (!startedRemainder) await pushRoomState(podId);
              }),
            );
            ensureTicking();
            log(`capsule ${capsuleId}: ${opened.podIds.length} remainder pod(s) opened with ${opened.lotIds.length} tier(s)`);
            return;
          }
        }
      }

      const { closed, nextKey } = await closeCapsuleIfDone(prisma, capsuleId);
      if (!closed) return;

      log(`capsule ${capsuleId} closed`);
      broadcastAll("CAPSULE_CLOSED", { capsuleId, nextKey });

      if (!nextKey) {
        log("event complete - every capsule is settled");
        broadcastAll("EVENT_COMPLETE");
        return;
      }

      // Nothing opens on its own. The next capsule waits for the organiser
      // (Force in development, the admin portal in production) to open it.
      log(`capsule ${capsuleId} complete; waiting for the organiser to open ${nextKey}`);
    } catch (error) {
      log("afterLotSettled failed", error?.message);
    } finally {
      advancing.delete(capsuleId);
    }
  }

  // ------------------------------------------------------------------- bids

  /**
   * Judge one bid and return the acknowledgement the caller sends straight
   * back through Socket.IO. Room-wide news (OUTBID) is still broadcast.
   */
  async function handleBid(socket, { lotId, amount }) {
    const podId = socket.data.podId;
    const teamId = socket.data.teamId;

    return withLotLock(lotId, async () => {
      const lot = await prisma.lot.findUnique({
        where: { id: lotId },
        relationLoadStrategy: "join",
        include: {
          subCapsule: true,
          pod: { select: { id: true, capsuleId: true, kind: true, capsule: { select: { key: true } } } },
          bids: { orderBy: [{ amount: "desc" }, { createdAt: "asc" }], take: 1 },
        },
      });

      if (!lot || lot.pod.id !== podId) {
        return {
          ok: false,
          lotId,
          code: "UNKNOWN",
          reason: "That lot is not in your pod.",
        };
      }

      const [membership, settled] = await Promise.all([
        prisma.podMembership.findUnique({ where: { podId_teamId: { podId, teamId } } }),
        prisma.settlement.findMany({ where: { teamId }, select: { pricePaid: true, capsuleId: true } }),
      ]);

      const spent = settled.reduce((total, s) => total + s.pricePaid, 0);
      const hasWonInCapsule = settled.some((s) => s.capsuleId === lot.pod.capsuleId);
      const topBid = lot.bids[0] ?? null;
      const isRemainder = lot.pod.kind === "REMAINDER";

      // In the remainder pod every tier is open at once, so a team could sit on
      // several. It may hold one claim at a time (rulebook 7).
      let holdsAnotherClaim = false;
      if (isRemainder) {
        // topBidId is a plain column rather than a Prisma relation, so this
        // joins it by hand — one round trip instead of two.
        const held = await prisma.$queryRaw`
          SELECT count(*)::int AS n
            FROM lots l
            JOIN bids b ON b.id = l."topBidId"
           WHERE l."podId" = ${podId}
             AND l.status = 'OPEN'
             AND l.id <> ${lotId}
             AND b."teamId" = ${teamId}
        `;
        holdsAnotherClaim = (held[0]?.n ?? 0) > 0;
      }

      // The remainder pod is priced off the frozen average, not the list price,
      // and its cheapest tier is claimable rather than auto-assigned.
      const entryPrice = isRemainder
        ? (lot.frozenPrice ?? lot.subCapsule.startingBid)
        : lot.subCapsule.startingBid;

      const verdict = validateBid({
        amount,
        now: new Date(),
        lotStatus: lot.status,
        closesAt: lot.closesAt,
        isAutoAssigned: isRemainder ? false : lot.subCapsule.isAutoAssigned,
        startingBid: entryPrice,
        minIncrement: lot.subCapsule.minIncrement,
        topAmount: topBid ? topBid.amount : null,
        topTeamId: topBid ? topBid.teamId : null,
        teamId,
        isSeatedInPod: Boolean(membership),
        hasWonInCapsule,
        remainingBalance: STARTING_BALANCE - spent,
        reserve: reserveAfter(lot.pod.capsule.key),
        holdsAnotherClaim,
        timerStarted: lot.closesAt !== null,
      });

      if (!verdict.ok) {
        devLog(
          podId,
          `Rejected ${amount} from ${membership?.teamName ?? teamId}: ${verdict.reason}`,
          "warn",
        );
        return {
          ok: false,
          lotId,
          code: verdict.code,
          reason: verdict.reason,
          nextMin:
            verdict.nextMin ??
            nextMinBid({
              startingBid: entryPrice,
              minIncrement: lot.subCapsule.minIncrement,
              topAmount: topBid ? topBid.amount : null,
            }),
        };
      }

      const now = new Date();
      const closesAt = computeClosesAt({ openedAt: lot.openedAt ?? now, lastBidAt: now });

      // Recording a bid is two writes — append to the log, then point the lot
      // at the new top and push the deadline out. As a transaction that is
      // BEGIN, INSERT, UPDATE, COMMIT: four round trips, and the room is
      // waiting for all of them. A data-modifying CTE does both in a single
      // statement, which Postgres runs atomically, in one round trip.
      const bidId = randomUUID();
      await prisma.$executeRaw`
        WITH new_bid AS (
          INSERT INTO bids (id, "lotId", "teamId", amount, "placedBy", "createdAt")
          VALUES (${bidId}, ${lotId}, ${teamId}, ${verdict.amount}, ${membership?.leadEmail ?? null}, now())
          RETURNING id
        )
        UPDATE lots
           SET "topBidId" = ${bidId}, "closesAt" = ${closesAt}
         WHERE id = ${lotId}
      `;

      deadlines.set(lotId, { podId, closesAt: closesAt.getTime() });

      const nextMin = verdict.amount + (lot.subCapsule.minIncrement ?? 0);

      // Everyone else in the room hears about it; the bidder gets the result
      // as this function's return value, sent back as the Socket.IO ack.
      broadcast(
        podId,
        "OUTBID",
        {
          lotId,
          byTeamName: membership?.teamName ?? "Another team",
          amount: verdict.amount,
          nextMin,
        },
        { except: socket },
      );
      devLog(
        podId,
        `Bid accepted: ${membership?.teamName ?? teamId} -> ${verdict.amount} on "${lot.subCapsule.name}". Next min ${nextMin}. Closes ${closesAt.toISOString()}.`,
      );

      // Deliberately not awaited: the room already has OUTBID, and holding the
      // lot lock through another read would stall the next bid.
      void pushRoomState(podId).catch((error) => log("pushRoomState failed", error?.message));

      return { ok: true, lotId, amount: verdict.amount, bidId };
    });
  }

  // ------------------------------------------------------------ connections

  /**
   * Seat a socket in its pod. Returns false when the team has no seat, and the
   * caller disconnects it — a client cannot talk its way into a room.
   */
  async function attach(socket, { podId, teamId, email }) {
    const membership = await prisma.podMembership.findUnique({
      where: { podId_teamId: { podId, teamId } },
    });

    if (!membership) {
      socket.emit("ROOM_ERROR", {
        message: "Your team is not seated in this pod. Hit Start on the capsule first.",
      });
      return false;
    }

    // The membership row snapshots the lead for the round. Anyone else on the
    // roster reads the team's progress from the database instead of sitting
    // in here — a member in the room would also count towards quorum.
    if (membership.leadEmail.toLowerCase() !== String(email ?? "").toLowerCase()) {
      socket.emit("ROOM_ERROR", {
        message: "Only the team lead's account can enter the bidding room.",
      });
      return false;
    }

    socket.data.podId = podId;
    socket.data.teamId = teamId;
    await socket.join(podId);
    occupiedPods.add(podId);

    const size = (await io.in(podId).fetchSockets()).length;
    log(`join pod=${podId} team=${membership.teamName} (${size} online)`);
    devLog(podId, `${membership.teamName} (${membership.leadName}) joined the room.`);

    const started = await maybeStartTimers(podId);
    if (!started) await pushRoomState(podId);
    ensureTicking();
    return true;
  }

  /** Socket.IO removes the socket from its rooms itself; this refreshes state. */
  async function detach(socket) {
    const podId = socket.data?.podId;
    if (!podId) return;

    const remaining = (await io.in(podId).fetchSockets()).filter((s) => s.id !== socket.id);
    if (remaining.length === 0) {
      occupiedPods.delete(podId);
      return;
    }
    await pushRoomState(podId).catch(() => undefined);
  }

  // ------------------------------------------------------------------- tick

  /**
   * Lots that are due to close. Every pod in a capsule opens its first tier at
   * the same instant, so they also fall due at the same instant — settling all
   * of them at once would take every connection in the pool and leave nothing
   * for the people still bidding in other pods.
   */
  const closeQueue = [];
  let closing = 0;

  function drainCloseQueue() {
    while (closing < CLOSE_CONCURRENCY && closeQueue.length > 0) {
      const lotId = closeQueue.shift();
      closing += 1;
      void closeLot(lotId)
        .catch((error) => log("closeLot failed", error?.message))
        .finally(() => {
          closing -= 1;
          drainCloseQueue();
        });
    }
  }

  function ensureTicking() {
    if (ticking) return;
    ticking = setInterval(() => {
      const now = Date.now();
      for (const [lotId, entry] of deadlines) {
        if (entry.closesAt <= now) {
          deadlines.delete(lotId);
          closeQueue.push(lotId);
        }
      }
      if (closeQueue.length > 0) drainCloseQueue();

      if (deadlines.size === 0 && occupiedPods.size === 0 && closeQueue.length === 0 && closing === 0) {
        clearInterval(ticking);
        ticking = null;
      }
    }, TICK_MS);
    if (typeof ticking.unref === "function") ticking.unref();
  }

  /** Called by the admin router's Start routes once pods and lots exist in the DB. */
  async function onCapsuleStarted(capsuleId) {
    // One query for every open lot in the capsule. Walking pod by pod costs a
    // round trip each, which for 15 pods is most of a minute against Neon.
    const open = await prisma.lot.findMany({
      where: { status: "OPEN", pod: { capsuleId } },
      select: { id: true, podId: true, closesAt: true },
    });

    const podIds = new Set();
    for (const lot of open) {
      podIds.add(lot.podId);
      if (lot.closesAt) {
        deadlines.set(lot.id, { podId: lot.podId, closesAt: lot.closesAt.getTime() });
      }
    }

    // Only rooms somebody is actually sitting in need a snapshot pushed;
    // the rest get theirs when a client joins.
    const occupied = [...podIds].filter((podId) => occupiedPods.has(podId));
    await Promise.all(occupied.map((podId) => pushRoomState(podId)));

    ensureTicking();
    log(
      `capsule ${capsuleId}: ${podIds.size} pods with an open lot, ${occupied.length} room(s) occupied`,
    );
  }

  async function announceCapsuleStarted(capsuleId) {
    await onCapsuleStarted(capsuleId);
    const capsule = await prisma.capsule.findUnique({
      where: { id: capsuleId },
      select: { key: true },
    });
    if (capsule) {
      broadcastAll("CAPSULE_OPENED", { capsuleKey: capsule.key, capsuleId });
    }
  }

  function onEventReset() {
    deadlines.clear();
    advancing.clear();
    closeQueue.length = 0;
  }

  /** Replace a pod's timer references after an organiser rewinds that pod. */
  async function onPodReset(podId) {
    for (const [lotId, entry] of deadlines) {
      if (entry.podId === podId) deadlines.delete(lotId);
    }

    const started = await maybeStartTimers(podId);
    if (!started) await pushRoomState(podId);
    ensureTicking();
  }

  /** Rehydrate open lots after a restart so timers survive a reload. */
  async function hydrate() {
    // Open every connection before anyone arrives. Cold, five people joining a
    // room together wait ~8s while Neon negotiates five connections; warm, the
    // same five are served in well under a second.
    const warmStart = Date.now();
    await Promise.all(
      Array.from({ length: POOL_SIZE }, () => prisma.$queryRaw`select 1`),
    ).catch((error) => log("pool warm-up failed", error?.message));
    log(`connection pool warmed (${POOL_SIZE}) in ${Date.now() - warmStart}ms`);

    const open = await prisma.lot.findMany({
      where: { status: "OPEN" },
      select: { id: true, podId: true, closesAt: true },
    });
    for (const lot of open) {
      if (lot.closesAt) deadlines.set(lot.id, { podId: lot.podId, closesAt: lot.closesAt.getTime() });
    }
    if (open.length) {
      log(`hydrated ${open.length} open lot(s)`);
      ensureTicking();
    }
  }

  return {
    prisma,
    attach,
    detach,
    handleBid,
    pushRoomState,
    onCapsuleStarted,
    announceCapsuleStarted,
    onEventReset,
    onPodReset,
    onlineTeamsByPod,
    broadcastAll,
    hydrate,
  };
}
