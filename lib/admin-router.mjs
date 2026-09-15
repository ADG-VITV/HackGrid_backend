/**
 * Express router for the organiser (admin) portal.
 *
 * This used to be a set of Next server actions living next to the admin page,
 * which reached the Socket.IO hub through globalThis because Next and the hub
 * shared a process. Now the hub is passed in directly. The engine functions and
 * the messages returned are the same.
 *
 * Every mutation is behind the organiser gate (lib/organiser-auth.mjs). The
 * read-only context endpoint is open, as the admin page read it without a
 * gate before.
 *
 * Mounted at /api/admin by server.mjs.
 */

import { Router } from "express";
import {
  addTeamToPod,
  createManualPod,
  deleteManualPod,
  getAdminEventContext,
  removeTeamFromPod,
  resetCapsule,
  resetEvent,
  resetPod,
  resetSubCapsule,
  setPodRemainderFlag,
  startCapsule,
  startEvent,
} from "./auction-engine.mjs";
import { getJudgingAdminContext, reviewApplication, setJudgeStatus } from "./judging-engine.mjs";

/** Wraps an async handler so a rejected promise reaches Express's error handler. */
const route = (handler) => (req, res, nextFn) => Promise.resolve(handler(req, res)).catch(nextFn);

function parseTeamId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) ? id : null;
}

function parsePodNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function createAdminRouter({ prisma, hub, organiserOnly }) {
  const router = Router();

  /** Announce a capsule's pods to whoever is in their rooms. */
  async function notifyHub(capsuleId) {
    if (hub?.announceCapsuleStarted) {
      await hub.announceCapsuleStarted(capsuleId).catch(() => undefined);
      return;
    }
    await hub?.onCapsuleStarted?.(capsuleId).catch(() => undefined);
  }

  /** The event is gone: eject every room so leads fall back to waiting. */
  async function notifyReset() {
    await hub?.onEventReset?.().catch(() => undefined);
  }

  /** One round went back to pending: close only its rooms. */
  async function notifyCapsuleReset(capsuleId) {
    await hub?.onCapsuleReset?.(capsuleId).catch(() => undefined);
  }

  /** Send an engine report with the HTTP status its outcome implies. */
  function reply(res, report) {
    res.status(report.status === "success" ? 200 : 400).json(report);
  }

  // Presence is the same signal the bidding page paints its green dots from:
  // a team is "online" when it holds a socket in its pod room. Only the live
  // round's pods can have sockets, so every other pod simply reads as empty.
  router.get(
    "/context",
    route(async (_req, res) => {
      const [context, onlineByPod, judging] = await Promise.all([
        getAdminEventContext(prisma),
        hub?.onlineTeamsByPod?.().catch(() => null) ?? Promise.resolve(null),
        getJudgingAdminContext(prisma),
      ]);

      for (const capsule of context.capsules) {
        for (const pod of capsule.pods) {
          const online = onlineByPod?.get(pod.id) ?? new Set();
          pod.teams = pod.teams.map((team) => ({ ...team, online: online.has(team.id) }));
          pod.onlineCount = pod.teams.filter((team) => team.online).length;
        }
      }

      // Judge applications ride the same 10 s poll as everything else on the
      // page, so a new applicant shows up without a manual refresh.
      res.json({ ...context, judging });
    }),
  );

  router.post(
    "/event/start",
    organiserOnly,
    route(async (_req, res) => {
      reply(res, await startEvent(prisma));
    }),
  );

  router.post(
    "/event/reset",
    organiserOnly,
    route(async (_req, res) => {
      const { removed } = await resetEvent(prisma);
      await notifyReset();
      res.json({
        status: "success",
        message: `Reset ${removed} round(s). Teams remain onboarded; start the event again to prepare fresh pods.`,
      });
    }),
  );

  router.post(
    "/capsules/:key/start",
    organiserOnly,
    route(async (req, res) => {
      const report = await startCapsule(prisma, req.params.key);
      if (report.status === "success") await notifyHub(report.capsuleId);
      reply(res, report);
    }),
  );

  router.post(
    "/capsules/:key/reset",
    organiserOnly,
    route(async (req, res) => {
      const report = await resetCapsule(prisma, req.params.key);
      // The round is pending again, so its rooms close. This must not
      // announce CAPSULE_OPENED — nothing opened.
      if (report.status === "success") {
        if (report.capsuleId) await notifyCapsuleReset(report.capsuleId);
        else await notifyReset();
      }
      reply(res, report);
    }),
  );

  router.post(
    "/capsules/:key/sub-capsules/:subKey/reset",
    organiserOnly,
    route(async (req, res) => {
      const report = await resetSubCapsule(prisma, req.params.key, req.params.subKey);
      if (report.status === "success" && report.capsuleId) await notifyHub(report.capsuleId);
      reply(res, report);
    }),
  );

  router.post(
    "/capsules/:key/pods",
    organiserOnly,
    route(async (req, res) => {
      const podNumber = parsePodNumber(req.body?.podNumber);
      if (podNumber === null) {
        return res.status(400).json({ status: "error", message: "Enter a pod number." });
      }
      const kind = req.body?.isRemainder === true ? "REMAINDER" : "MAIN";
      reply(res, await createManualPod(prisma, req.params.key, podNumber, kind));
    }),
  );

  router.post(
    "/capsules/:key/pods/:podId/reset",
    organiserOnly,
    route(async (req, res) => {
      const report = await resetPod(prisma, req.params.key, req.params.podId);
      if (report.status === "success") {
        await hub?.onPodReset?.(report.podId).catch(() => undefined);
      }
      reply(res, report);
    }),
  );

  router.post(
    "/capsules/:key/pods/:podId/teams",
    organiserOnly,
    route(async (req, res) => {
      const teamId = parseTeamId(req.body?.teamId);
      if (teamId === null) {
        return res.status(400).json({ status: "error", message: "Pick a team to add." });
      }
      reply(res, await addTeamToPod(prisma, req.params.key, req.params.podId, teamId));
    }),
  );

  router.delete(
    "/capsules/:key/pods/:podId/teams/:teamId",
    organiserOnly,
    route(async (req, res) => {
      const teamId = parseTeamId(req.params.teamId);
      if (teamId === null) {
        return res.status(400).json({ status: "error", message: "Unknown team." });
      }
      reply(res, await removeTeamFromPod(prisma, req.params.key, req.params.podId, teamId));
    }),
  );

  router.patch(
    "/capsules/:key/pods/:podId/remainder",
    organiserOnly,
    route(async (req, res) => {
      const flagged = req.body?.flagged === true;
      reply(res, await setPodRemainderFlag(prisma, req.params.key, req.params.podId, flagged));
    }),
  );

  router.delete(
    "/capsules/:key/pods/:podId",
    organiserOnly,
    route(async (req, res) => {
      reply(res, await deleteManualPod(prisma, req.params.key, req.params.podId));
    }),
  );

  // ------------------------------------------------------------- judging

  router.post(
    "/judges/applications/:applicationId/approve",
    organiserOnly,
    route(async (req, res) => {
      reply(res, await reviewApplication(prisma, req.params.applicationId, "APPROVED"));
    }),
  );

  router.post(
    "/judges/applications/:applicationId/reject",
    organiserOnly,
    route(async (req, res) => {
      reply(res, await reviewApplication(prisma, req.params.applicationId, "REJECTED"));
    }),
  );

  router.post(
    "/judges/:judgeId/suspend",
    organiserOnly,
    route(async (req, res) => {
      reply(res, await setJudgeStatus(prisma, req.params.judgeId, "SUSPENDED"));
    }),
  );

  router.post(
    "/judges/:judgeId/reinstate",
    organiserOnly,
    route(async (req, res) => {
      reply(res, await setJudgeStatus(prisma, req.params.judgeId, "ACTIVE"));
    }),
  );

  return router;
}
