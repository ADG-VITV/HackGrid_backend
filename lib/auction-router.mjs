/**
 * Express router for the auction.
 *
 * Everything here is a thin HTTP wrapper over lib/auction-engine.mjs — the same
 * functions the admin router and the websocket hub call. There is no second
 * copy of the rules, so an organiser hitting these endpoints and a team using
 * the UI can never disagree about the state of the event.
 *
 * Organiser routes share the gate in lib/organiser-auth.mjs with /api/admin.
 *
 * Mounted at /api/auction by server.mjs.
 */

import { Router } from "express";
import {
  getBiddingContext,
  liveCapsule,
  listCapsules,
  resetEvent,
  startCapsule,
  startEvent,
} from "./auction-engine.mjs";

/** Wraps an async handler so a rejected promise reaches Express's error handler. */
const route = (handler) => (req, res, nextFn) => Promise.resolve(handler(req, res)).catch(nextFn);

export function createAuctionRouter({ prisma, hub, organiserOnly }) {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ status: "ok", at: new Date().toISOString() });
  });

  // The running order and where each round has got to.
  router.get(
    "/state",
    route(async (_req, res) => {
      const [capsules, live] = await Promise.all([listCapsules(prisma), liveCapsule(prisma)]);
      res.json({ status: "success", capsules, live });
    }),
  );

  // One team's view: their seat in the live round plus what they already own.
  router.get(
    "/context/:teamIdOrEmail",
    route(async (req, res) => {
      const context = await getBiddingContext(prisma, req.params.teamIdOrEmail);
      res.status(context.status === "error" ? 404 : 200).json(context);
    }),
  );

  // The Resource Manager, on its own so a team member can poll just this.
  router.get(
    "/teams/:teamIdOrEmail/resources",
    route(async (req, res) => {
      const context = await getBiddingContext(prisma, req.params.teamIdOrEmail);
      if (!context.resources) {
        return res.status(404).json({ status: "error", message: context.message || "Unknown team." });
      }
      res.json({ status: "success", resources: context.resources });
    }),
  );

  // Prepare the event: draw pods for every round. Opens nothing — each
  // capsule opens solely when the organiser starts it; nothing chains on its
  // own. Same function the admin router's Start-event route calls.
  router.post(
    "/start",
    organiserOnly,
    route(async (_req, res) => {
      const report = await startEvent(prisma);
      if (report.status !== "success") {
        return res.status(400).json(report);
      }
      res.json(report);
    }),
  );

  // Force one round open out of order. Development convenience.
  router.post(
    "/capsules/:key/start",
    organiserOnly,
    route(async (req, res) => {
      const report = await startCapsule(prisma, req.params.key, { force: true });
      if (report.status !== "success") {
        return res.status(400).json(report);
      }
      await hub?.onCapsuleStarted?.(report.capsuleId).catch(() => undefined);
      hub?.broadcastAll?.("CAPSULE_OPENED", {
        capsuleKey: report.capsuleKey,
        capsuleId: report.capsuleId,
      });
      res.json(report);
    }),
  );

  router.post(
    "/reset",
    organiserOnly,
    route(async (_req, res) => {
      const { removed } = await resetEvent(prisma);
      await hub?.onEventReset?.().catch(() => undefined);
      res.json({
        status: "success",
        message: `Removed ${removed} pod(s) with their lots, bids and settlements.`,
      });
    }),
  );

  return router;
}
