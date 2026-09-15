/**
 * Seed the judging side of the event. Idempotent — run it as often as you
 * like; anything already present is left untouched.
 *
 *   - the event row (keyed, never duplicated)
 *   - the five official judging criteria (rows, so the rubric is data)
 *   - one shared judge invitation, hashed from HACKGRID_JUDGE_INVITE_CODE
 *
 * The invitation code is required and has no default: it is the secret a
 * judge types to apply (and again to open the evaluations), so it must be
 * chosen by the organiser, never baked into the repository.
 *
 *   HACKGRID_JUDGE_INVITE_CODE="something-long" npm run db:seed
 */

import { createHash } from "node:crypto";
import { loadEnvFile } from "node:process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

try {
  loadEnvFile();
} catch {
  // Fine — the host may inject the variables directly.
}

const EVENT_KEY = "hackgrid-default";

/** The rubric. Totals are the plain sum: 20 + 20 + 20 + 15 + 25 = 100. */
const CRITERIA = [
  {
    key: "problem-market",
    name: "Problem & Market Opportunity",
    description: "Severity and value of the problem, market demand, audience size.",
    displayOrder: 1,
    minScore: 0,
    maxScore: 20,
  },
  {
    key: "saas-potential",
    name: "SaaS Business Potential",
    description: "Scalability, customer value, competitive advantage, long-term viability.",
    displayOrder: 2,
    minScore: 0,
    maxScore: 20,
  },
  {
    key: "product-execution",
    name: "Product Execution",
    description: "Functionality, UX, reliability, demo quality.",
    displayOrder: 3,
    minScore: 0,
    maxScore: 20,
  },
  {
    key: "innovation",
    name: "Innovation",
    description: "Creativity in idea and in using acquired data, AI, and integrations.",
    displayOrder: 4,
    minScore: 0,
    maxScore: 15,
  },
  {
    key: "resource-utilization",
    name: "Resource Utilization Strategy",
    description:
      "How effectively auction purchases were converted into product value — strategic spending, full use of acquired capability, efficiency relative to cost.",
    displayOrder: 5,
    minScore: 0,
    maxScore: 25,
  },
];

function fail(message) {
  console.error(`[seed] ${message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.");

const rawCode = (process.env.HACKGRID_JUDGE_INVITE_CODE ?? "").replace(/\s+/g, "").toUpperCase();
if (rawCode.length < 8) {
  fail("HACKGRID_JUDGE_INVITE_CODE is not set (or shorter than 8 characters). Choose the code judges will use and set it in .env.");
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, max: 2 }),
});

async function main() {
  const event = await prisma.event.upsert({
    where: { key: EVENT_KEY },
    update: {},
    create: { key: EVENT_KEY, name: "HackGrid", startingBudget: 10000 },
  });

  let createdCriteria = 0;
  for (const criterion of CRITERIA) {
    const existing = await prisma.judgingCriterion.findUnique({
      where: { eventId_key: { eventId: event.id, key: criterion.key } },
    });
    if (existing) continue;
    await prisma.judgingCriterion.create({ data: { eventId: event.id, ...criterion } });
    createdCriteria += 1;
  }

  const codeHash = createHash("sha256").update(rawCode).digest("hex");
  const existingInvite = await prisma.judgeInvitation.findUnique({ where: { codeHash } });
  let createdInvite = false;
  if (!existingInvite) {
    await prisma.judgeInvitation.create({ data: { eventId: event.id, codeHash, expiresAt: null } });
    createdInvite = true;
  }

  const criteria = await prisma.judgingCriterion.count({ where: { eventId: event.id, active: true } });
  console.log(`[seed] event "${event.key}": ${criteria} active criteria (${createdCriteria} created).`);
  console.log(
    createdInvite
      ? "[seed] judge invitation created from HACKGRID_JUDGE_INVITE_CODE."
      : "[seed] judge invitation for HACKGRID_JUDGE_INVITE_CODE already exists.",
  );
}

main()
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
