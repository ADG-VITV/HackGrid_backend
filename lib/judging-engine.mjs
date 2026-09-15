/**
 * Judging: who may judge, what they see, what they submit, and what the
 * organiser decides. Plain JS over Prisma, free of transport concerns, so the
 * judge router and the admin router drive it through the same code.
 *
 * Identity arrives already verified (lib/judge-auth.mjs): every function that
 * acts for a judge takes the verified claims `{ uid, name, email }` and maps
 * the uid to a JudgeProfile and the ACTIVE JudgeEventAssignment for the
 * event. Names and emails stored here come from those claims, never from a
 * form.
 *
 * The rubric is data — active JudgingCriterion rows in displayOrder, with
 * minScore/maxScore as the only bounds. A submission's total is the plain sum
 * of its scores. Nothing here hard-codes the 20/20/20/15/25 split; that lives
 * in prisma/seed.mjs.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { ensureEvent } from "./auction-engine.mjs";

// ------------------------------------------------------------------ helpers

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Codes are compared case- and whitespace-insensitively. */
export function normaliseCode(value) {
  return String(value ?? "").replace(/\s+/g, "").toUpperCase();
}

export function hashInvitationCode(value) {
  return sha256(normaliseCode(value));
}

function normaliseName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The current event row, created if this is a fresh database. */
async function currentEvent(prisma) {
  return ensureEvent(prisma);
}

/** Active criteria in display order — the rubric as the UI should show it. */
async function criteriaFor(prisma, eventId) {
  const rows = await prisma.judgingCriterion.findMany({
    where: { eventId, active: true },
    orderBy: { displayOrder: "asc" },
  });
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    minScore: row.minScore,
    maxScore: row.maxScore,
    displayOrder: row.displayOrder,
  }));
}

function maxTotalOf(criteria) {
  return criteria.reduce((sum, criterion) => sum + criterion.maxScore, 0);
}

/**
 * Where a verified identity stands with this event. One lookup shared by every
 * judge-facing function so they all give the same answer.
 *
 * @returns {{ event, judge, assignment, application }} — judge/assignment
 *   null when not (yet) approved; application is the latest application row.
 */
async function standingOf(prisma, identity) {
  const event = await currentEvent(prisma);
  const [judge, application] = await Promise.all([
    prisma.judgeProfile.findUnique({ where: { firebaseUid: identity.uid } }),
    prisma.judgeApplication.findUnique({
      where: { eventId_firebaseUid: { eventId: event.id, firebaseUid: identity.uid } },
      select: { status: true },
    }),
  ]);
  const assignment = judge
    ? await prisma.judgeEventAssignment.findUnique({
        where: { judgeId_eventId: { judgeId: judge.id, eventId: event.id } },
      })
    : null;
  return { event, judge, assignment, application };
}

/** The message a not-active judge should see, or null when they are active. */
function refusalFor({ judge, assignment, application }) {
  if (!judge) {
    if (application?.status === "PENDING") {
      return { status: "pending", message: "Your judge application is awaiting an organiser decision." };
    }
    if (application?.status === "REJECTED") {
      return { status: "denied", message: "Your judge application was not approved." };
    }
    return { status: "no_profile", message: "Enter your invitation code to apply as a judge." };
  }
  if (!assignment) {
    return { status: "denied", message: "You are not assigned to judge this event yet." };
  }
  if (assignment.status !== "ACTIVE") {
    return { status: "denied", message: "Your judging access for this event is suspended." };
  }
  return null;
}

/** Resolve an active judge or return the report the caller should send. */
async function activeJudgeOr(prisma, identity) {
  const standing = await standingOf(prisma, identity);
  const refusal = refusalFor(standing);
  if (refusal) return { ok: false, report: { status: "error", code: refusal.status.toUpperCase(), message: refusal.message } };
  return { ok: true, ...standing };
}

async function findValidInvitation(prisma, eventId, code) {
  if (!normaliseCode(code)) return { invitation: null, reason: "Enter your invitation code." };
  const invitation = await prisma.judgeInvitation.findUnique({
    where: { codeHash: hashInvitationCode(code) },
  });
  if (!invitation || invitation.eventId !== eventId) {
    return { invitation: null, reason: "That invitation code is not valid for this event." };
  }
  if (invitation.expiresAt && invitation.expiresAt.getTime() < Date.now()) {
    return { invitation: null, reason: "That invitation code has expired." };
  }
  return { invitation, reason: null };
}

// ------------------------------------------------------------------ session

/**
 * What the judge portal should show a signed-in person: apply, wait, denied,
 * or the judging session with the rubric.
 */
export async function getJudgeSession(prisma, identity) {
  const standing = await standingOf(prisma, identity);
  const refusal = refusalFor(standing);
  if (refusal) return refusal;

  const { event, judge, assignment } = standing;
  const criteria = await criteriaFor(prisma, event.id);
  return {
    status: "active",
    message: `Signed in as ${judge.name}.`,
    session: {
      judgeId: judge.id,
      judgeName: judge.name,
      judgeEmail: judge.email,
      assignmentId: assignment.id,
      eventId: event.id,
      eventName: event.name,
      startingBudget: event.startingBudget,
      criteria,
      maxTotal: maxTotalOf(criteria),
    },
  };
}

/**
 * Redeem the shared invitation code: files a PENDING application for this
 * identity. The organiser approves it on /admin.
 */
export async function applyWithInvitation(prisma, identity, code) {
  const event = await currentEvent(prisma);
  const { invitation, reason } = await findValidInvitation(prisma, event.id, code);
  if (!invitation) return { status: "invalid", message: reason };

  // Snapshots from the verified token. Column widths: name 80, email 254.
  const name = (identity.name ?? "").trim().slice(0, 80) || "Judge";
  const email = (identity.email ?? "").trim().slice(0, 254) || `${identity.uid}@judge.local`;

  const existing = await prisma.judgeApplication.findUnique({
    where: { eventId_firebaseUid: { eventId: event.id, firebaseUid: identity.uid } },
    select: { status: true },
  });
  if (existing?.status === "PENDING") {
    return { status: "invalid", message: "Your judge application is already awaiting review." };
  }
  if (existing?.status === "APPROVED") {
    return { status: "invalid", message: "Your judge application has already been approved." };
  }
  if (existing?.status === "REJECTED") {
    return { status: "invalid", message: "Your judge application was rejected and cannot be resubmitted." };
  }

  try {
    await prisma.judgeApplication.create({
      data: {
        eventId: event.id,
        invitationId: invitation.id,
        firebaseUid: identity.uid,
        name,
        email,
        status: "PENDING",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { status: "invalid", message: "This Google account already has a judge application for this event." };
    }
    throw error;
  }

  return { status: "success", message: "Application sent. An organiser must approve it before you can judge." };
}

// ------------------------------------------------------------------- judging

/** Teams in the event matching `query` (name, code, or any member), with this judge's total if scored. */
export async function searchTeams(prisma, identity, query) {
  const resolved = await activeJudgeOr(prisma, identity);
  if (!resolved.ok) return { ...resolved.report, teams: [] };
  const { event, assignment } = resolved;

  const needle = String(query ?? "").trim();
  const where = {
    eventId: event.id,
    ...(needle
      ? {
          OR: [
            { name: { contains: needle, mode: "insensitive" } },
            { code: { contains: needle, mode: "insensitive" } },
            {
              members: {
                some: {
                  user: {
                    OR: [
                      { name: { contains: needle, mode: "insensitive" } },
                      { email: { contains: needle, mode: "insensitive" } },
                    ],
                  },
                },
              },
            },
          ],
        }
      : {}),
  };

  const teams = await prisma.team.findMany({
    where,
    relationLoadStrategy: "join",
    include: {
      leader: { select: { name: true } },
      members: { orderBy: { joinOrder: "asc" }, include: { user: { select: { name: true } } } },
    },
    orderBy: { name: "asc" },
    take: 200,
  });

  const evaluations = await prisma.evaluation.findMany({
    where: { eventId: event.id, judgeAssignmentId: assignment.id, teamId: { in: teams.map((t) => t.id) } },
    include: { scores: { select: { score: true } } },
  });
  const totalsByTeam = new Map(
    evaluations.map((evaluation) => [evaluation.teamId, evaluation.scores.reduce((sum, s) => sum + s.score, 0)]),
  );

  return {
    status: "success",
    message: `Found ${teams.length} team${teams.length === 1 ? "" : "s"}.`,
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      code: team.code,
      leaderName: team.leader.name,
      memberNames: team.members.map((member) => member.user.name),
      reviewedScore: totalsByTeam.get(team.id) ?? null,
    })),
  };
}

/** The team's four auction settlements, as a judge should read them. */
async function resourcesView(prisma, event, teamId) {
  const settlements = await prisma.settlement.findMany({
    where: { teamId, capsule: { eventId: event.id } },
    relationLoadStrategy: "join",
    include: {
      capsule: { select: { name: true, sequenceOrder: true } },
      subCapsule: { select: { name: true } },
    },
    orderBy: [{ capsule: { sequenceOrder: "asc" } }],
  });
  const spent = settlements.reduce((sum, s) => sum + s.pricePaid, 0);
  return {
    startingBudget: event.startingBudget,
    spent,
    remaining: event.startingBudget - spent,
    items: settlements.map((s) => ({
      roundOrder: s.capsule.sequenceOrder,
      roundName: s.capsule.name,
      tierName: s.subCapsule.name,
      pricePaid: s.pricePaid,
      priceSource: s.priceSource,
    })),
  };
}

async function evaluationView(prisma, eventId, judgeAssignmentId, teamId) {
  const evaluation = await prisma.evaluation.findUnique({
    where: { eventId_judgeAssignmentId_teamId: { eventId, judgeAssignmentId, teamId } },
    include: { scores: { include: { criterion: { select: { key: true } } } } },
  });
  if (!evaluation) return null;
  return {
    id: evaluation.id,
    status: evaluation.status,
    review: evaluation.review,
    scores: evaluation.scores.map((s) => ({ criterionId: s.criterionId, key: s.criterion.key, score: s.score })),
    total: evaluation.scores.reduce((sum, s) => sum + s.score, 0),
    submittedAt: evaluation.submittedAt?.toISOString() ?? null,
    updatedAt: evaluation.updatedAt.toISOString(),
  };
}

/** Everything the judge needs to review one team: roster, resources, prior evaluation. */
export async function getReviewContext(prisma, identity, teamId) {
  const resolved = await activeJudgeOr(prisma, identity);
  if (!resolved.ok) return { ...resolved.report, context: null };
  const { event, assignment } = resolved;

  if (!Number.isInteger(teamId)) return { status: "error", message: "Unknown team.", context: null };

  const team = await prisma.team.findUnique({
    where: { id_eventId: { id: teamId, eventId: event.id } },
    relationLoadStrategy: "join",
    include: { members: { orderBy: { joinOrder: "asc" }, include: { user: { select: { name: true, email: true } } } } },
  });
  if (!team) return { status: "error", message: "That team was not found in this event.", context: null };

  const [resources, evaluation] = await Promise.all([
    resourcesView(prisma, event, team.id),
    evaluationView(prisma, event.id, assignment.id, team.id),
  ]);

  return {
    status: "success",
    message: "",
    context: {
      team: {
        id: team.id,
        name: team.name,
        code: team.code,
        members: team.members.map((member) => ({
          name: member.user.name,
          email: member.user.email,
          isLeader: member.userId === team.leaderId,
        })),
      },
      resources,
      evaluation,
    },
  };
}

/**
 * Record (or replace) this judge's evaluation of a team. Every active
 * criterion must carry an integer within its own bounds; unknown criteria
 * are refused. Written as one transaction: upsert the evaluation, replace
 * its scores.
 */
export async function submitEvaluation(prisma, identity, teamId, { review, scores }) {
  const resolved = await activeJudgeOr(prisma, identity);
  if (!resolved.ok) return { ...resolved.report, evaluation: null };
  const { event, assignment } = resolved;

  if (!Number.isInteger(teamId)) return { status: "invalid", message: "Pick a team before submitting.", evaluation: null };

  const team = await prisma.team.findUnique({ where: { id_eventId: { id: teamId, eventId: event.id } }, select: { id: true } });
  if (!team) return { status: "invalid", message: "That team does not belong to this event.", evaluation: null };

  const criteria = await criteriaFor(prisma, event.id);
  if (criteria.length === 0) {
    return { status: "error", message: "No judging criteria have been configured yet. Run the seed.", evaluation: null };
  }

  const given = scores && typeof scores === "object" && !Array.isArray(scores) ? scores : {};
  const known = new Set(criteria.map((c) => c.id));
  for (const id of Object.keys(given)) {
    if (!known.has(id)) return { status: "invalid", message: "An unknown criterion was submitted.", evaluation: null };
  }

  const checked = {};
  for (const criterion of criteria) {
    const raw = given[criterion.id];
    const value = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
    if (typeof value !== "number" || !Number.isInteger(value)) {
      return { status: "invalid", message: `Give ${criterion.name} a score before submitting.`, evaluation: null };
    }
    if (value < criterion.minScore || value > criterion.maxScore) {
      return {
        status: "invalid",
        message: `${criterion.name} must be between ${criterion.minScore} and ${criterion.maxScore}.`,
        evaluation: null,
      };
    }
    checked[criterion.id] = value;
  }

  const reviewText = typeof review === "string" ? review.trim() : "";

  await prisma.$transaction(async (tx) => {
    const evaluation = await tx.evaluation.upsert({
      where: { eventId_judgeAssignmentId_teamId: { eventId: event.id, judgeAssignmentId: assignment.id, teamId } },
      update: { review: reviewText || null, status: "SUBMITTED", submittedAt: new Date() },
      create: {
        eventId: event.id,
        judgeAssignmentId: assignment.id,
        teamId,
        review: reviewText || null,
        status: "SUBMITTED",
        submittedAt: new Date(),
      },
    });
    await tx.evaluationScore.deleteMany({ where: { evaluationId: evaluation.id } });
    await tx.evaluationScore.createMany({
      data: criteria.map((criterion) => ({
        evaluationId: evaluation.id,
        criterionId: criterion.id,
        eventId: event.id,
        score: checked[criterion.id],
      })),
    });
  });

  return {
    status: "success",
    message: "Evaluation saved.",
    evaluation: await evaluationView(prisma, event.id, assignment.id, teamId),
  };
}

// ------------------------------------------------------------------- results

/**
 * The gate in front of the results page. An active judge re-enters their
 * name and the invitation code; only a match on the verified profile lets
 * them through. A signed-in person without a profile — never applied, still
 * pending, or rejected — is refused whatever they type.
 */
export async function verifyResultsAccess(prisma, identity, { name, code }) {
  const resolved = await activeJudgeOr(prisma, identity);
  if (!resolved.ok) {
    return { status: "denied", message: "Only approved judges can open the evaluations." };
  }
  const { event, judge } = resolved;

  if (!normaliseName(name)) return { status: "invalid", message: "Enter your name as it appears on your judge profile." };
  if (normaliseName(name) !== normaliseName(judge.name)) {
    return { status: "invalid", message: "That name does not match your judge profile." };
  }

  const { invitation, reason } = await findValidInvitation(prisma, event.id, code);
  if (!invitation) return { status: "invalid", message: reason };

  return { status: "success", message: `Verified ${judge.name}.` };
}

/** True when `code` is a valid invitation for the current event. */
export async function isValidResultsKey(prisma, code) {
  const event = await currentEvent(prisma);
  const { invitation } = await findValidInvitation(prisma, event.id, code);
  return Boolean(invitation);
}

/** Whether this identity is an active judge (used to gate the results read). */
export async function isActiveJudge(prisma, identity) {
  const resolved = await activeJudgeOr(prisma, identity);
  return resolved.ok;
}

/** Every submitted evaluation, grouped by team, with per-team averages. */
export async function getResults(prisma) {
  const event = await currentEvent(prisma);
  const [criteria, evaluations] = await Promise.all([
    criteriaFor(prisma, event.id),
    prisma.evaluation.findMany({
      where: { eventId: event.id, status: "SUBMITTED" },
      relationLoadStrategy: "join",
      orderBy: { submittedAt: "desc" },
      include: {
        team: { select: { id: true, name: true, code: true } },
        judgeAssignment: { select: { judge: { select: { name: true } } } },
        scores: { select: { criterionId: true, score: true } },
      },
    }),
  ]);

  const byTeam = new Map();
  for (const evaluation of evaluations) {
    const total = evaluation.scores.reduce((sum, s) => sum + s.score, 0);
    const entry = byTeam.get(evaluation.team.id) ?? {
      id: evaluation.team.id,
      name: evaluation.team.name,
      code: evaluation.team.code,
      evaluations: [],
    };
    entry.evaluations.push({
      id: evaluation.id,
      judgeName: evaluation.judgeAssignment.judge.name,
      review: evaluation.review,
      total,
      scores: evaluation.scores.map((s) => ({ criterionId: s.criterionId, score: s.score })),
      submittedAt: evaluation.submittedAt?.toISOString() ?? null,
    });
    byTeam.set(evaluation.team.id, entry);
  }

  const teams = [...byTeam.values()]
    .map((team) => ({
      ...team,
      average: team.evaluations.reduce((sum, e) => sum + e.total, 0) / team.evaluations.length,
    }))
    .sort((left, right) => right.average - left.average || left.name.localeCompare(right.name));

  return {
    status: "success",
    eventName: event.name,
    criteria,
    maxTotal: maxTotalOf(criteria),
    teams,
  };
}

// -------------------------------------------------------------------- admin

/** Applications and approved judges, for the organiser portal. */
export async function getJudgingAdminContext(prisma) {
  const event = await currentEvent(prisma);
  const [applications, assignments, criteriaCount, invitationCount] = await Promise.all([
    prisma.judgeApplication.findMany({
      where: { eventId: event.id },
      orderBy: [{ status: "asc" }, { submittedAt: "asc" }],
    }),
    prisma.judgeEventAssignment.findMany({
      where: { eventId: event.id },
      relationLoadStrategy: "join",
      include: { judge: true, _count: { select: { evaluations: true } } },
      orderBy: { approvedAt: "asc" },
    }),
    prisma.judgingCriterion.count({ where: { eventId: event.id, active: true } }),
    prisma.judgeInvitation.count({ where: { eventId: event.id } }),
  ]);

  return {
    seeded: criteriaCount > 0 && invitationCount > 0,
    criteriaCount,
    applications: applications.map((a) => ({
      id: a.id,
      name: a.name,
      email: a.email,
      status: a.status,
      submittedAt: a.submittedAt.toISOString(),
      reviewedAt: a.reviewedAt?.toISOString() ?? null,
    })),
    judges: assignments.map((a) => ({
      judgeId: a.judgeId,
      name: a.judge.name,
      email: a.judge.email,
      status: a.status,
      approvedAt: a.approvedAt.toISOString(),
      evaluationCount: a._count.evaluations,
    })),
  };
}

/** Approve (profile + ACTIVE assignment) or reject a pending application. */
export async function reviewApplication(prisma, applicationId, decision) {
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    return { status: "error", message: "Invalid judge application decision." };
  }
  const application = await prisma.judgeApplication.findUnique({ where: { id: String(applicationId ?? "") } });
  if (!application) return { status: "error", message: "Judge application was not found." };
  if (application.status !== "PENDING") {
    return { status: "error", message: "This judge application has already been reviewed." };
  }

  await prisma.$transaction(async (tx) => {
    if (decision === "REJECTED") {
      await tx.judgeApplication.update({
        where: { id: application.id },
        data: { status: "REJECTED", reviewedAt: new Date() },
      });
      return;
    }
    const judge = await tx.judgeProfile.upsert({
      where: { firebaseUid: application.firebaseUid },
      update: { name: application.name, email: application.email },
      create: { firebaseUid: application.firebaseUid, name: application.name, email: application.email },
    });
    await tx.judgeEventAssignment.upsert({
      where: { judgeId_eventId: { judgeId: judge.id, eventId: application.eventId } },
      update: { status: "ACTIVE", approvedAt: new Date() },
      create: { judgeId: judge.id, eventId: application.eventId, status: "ACTIVE" },
    });
    await tx.judgeApplication.update({
      where: { id: application.id },
      data: { status: "APPROVED", reviewedAt: new Date(), judgeId: judge.id },
    });
  });

  return {
    status: "success",
    message: decision === "APPROVED" ? `${application.name} is now a judge.` : `${application.name}'s application was rejected.`,
  };
}

/** Suspend or reinstate an approved judge for this event. Evaluations are kept. */
export async function setJudgeStatus(prisma, judgeId, status) {
  if (status !== "ACTIVE" && status !== "SUSPENDED") {
    return { status: "error", message: "Invalid judge status." };
  }
  const event = await currentEvent(prisma);
  const assignment = await prisma.judgeEventAssignment.findUnique({
    where: { judgeId_eventId: { judgeId: String(judgeId ?? ""), eventId: event.id } },
    include: { judge: { select: { name: true } } },
  });
  if (!assignment) return { status: "error", message: "That judge is not assigned to this event." };
  if (assignment.status === status) {
    return { status: "error", message: `${assignment.judge.name} is already ${status.toLowerCase()}.` };
  }
  await prisma.judgeEventAssignment.update({ where: { id: assignment.id }, data: { status } });
  return {
    status: "success",
    message: status === "SUSPENDED" ? `${assignment.judge.name} is suspended.` : `${assignment.judge.name} is reinstated.`,
  };
}
