/**
 * Express router for the judge portal. Mounted at /api/judge by server.mjs.
 *
 * Every route needs a verified Firebase ID token (lib/judge-auth.mjs) in
 * `Authorization: Bearer <token>`; the judging engine then decides what that
 * person may do. The results read additionally needs the invitation code
 * re-entered on the portal (x-judge-results-key), or the organiser's admin
 * key.
 *
 * Responses follow the rest of the API: `{ status, message, ... }`, 4xx for
 * a refusal the UI renders inline, 401 for a missing/invalid token.
 */

import { Router } from "express";
import { JUDGE_RESULTS_KEY_HEADER, requireJudgeIdentity, verifyIdToken, bearerToken } from "./judge-auth.mjs";
import {
  applyWithInvitation,
  getJudgeSession,
  getResults,
  getReviewContext,
  isActiveJudge,
  isValidResultsKey,
  searchTeams,
  submitEvaluation,
  verifyResultsAccess,
} from "./judging-engine.mjs";

/** Wraps an async handler so a rejected promise reaches Express's error handler. */
const route = (handler) => (req, res, nextFn) => Promise.resolve(handler(req, res)).catch(nextFn);

function httpStatusFor(report) {
  if (report.status === "success" || report.status === "active") return 200;
  if (report.status === "signed_out") return 401;
  if (report.code === "SIGNED_OUT") return 401;
  return 400;
}

export function createJudgeRouter({ prisma, isOrganiser }) {
  const router = Router();

  // Where this person stands: apply / pending / denied / active (+ rubric).
  router.get(
    "/session",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await getJudgeSession(prisma, req.judgeIdentity);
      res.json(report);
    }),
  );

  // Redeem the invitation code -> PENDING application.
  router.post(
    "/apply",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await applyWithInvitation(prisma, req.judgeIdentity, req.body?.code);
      res.status(httpStatusFor(report)).json(report);
    }),
  );

  router.get(
    "/teams",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await searchTeams(prisma, req.judgeIdentity, req.query.q);
      res.status(httpStatusFor(report)).json(report);
    }),
  );

  router.get(
    "/teams/:teamId/review",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await getReviewContext(prisma, req.judgeIdentity, Number.parseInt(req.params.teamId, 10));
      res.status(httpStatusFor(report)).json(report);
    }),
  );

  router.put(
    "/teams/:teamId/evaluation",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await submitEvaluation(prisma, req.judgeIdentity, Number.parseInt(req.params.teamId, 10), {
        review: req.body?.review,
        scores: req.body?.scores,
      });
      res.status(httpStatusFor(report)).json(report);
    }),
  );

  // The popup before the evaluations page: name + invitation code.
  router.post(
    "/results-access",
    requireJudgeIdentity,
    route(async (req, res) => {
      const report = await verifyResultsAccess(prisma, req.judgeIdentity, {
        name: req.body?.name,
        code: req.body?.code,
      });
      res.status(report.status === "success" ? 200 : 403).json(report);
    }),
  );

  // Everyone's submitted evaluations. Open to an active judge who has passed
  // the popup (token + results key), or to the organiser (admin key).
  router.get(
    "/results",
    route(async (req, res) => {
      let allowed = isOrganiser(req);

      if (!allowed) {
        const identity = await verifyIdToken(bearerToken(req));
        const key = req.get(JUDGE_RESULTS_KEY_HEADER) ?? "";
        allowed =
          Boolean(identity) &&
          (await isActiveJudge(prisma, identity)) &&
          (await isValidResultsKey(prisma, key));
      }

      if (!allowed) {
        return res.status(403).json({
          status: "error",
          message: "Verify yourself from the judge portal before opening the evaluations.",
        });
      }

      res.json(await getResults(prisma));
    }),
  );

  return router;
}

