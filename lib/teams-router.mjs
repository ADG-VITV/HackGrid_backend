/**
 * Express router for teams: create, join, look up by email, and the
 * development-only roster used by the "act as" picker.
 *
 * This used to be a set of Next server actions living next to the teams page.
 * The logic is unchanged — same validation, same messages, same response
 * shapes — it has only moved behind HTTP so the frontend can run anywhere.
 *
 * Mounted at /api/teams by server.mjs.
 */

import { randomInt } from "node:crypto";
import { Router } from "express";
import { Prisma } from "@prisma/client";

const teamInclude = {
  members: {
    orderBy: { joinOrder: "asc" },
    include: { user: true },
  },
};

const maxTeamMembers = 6;

/** Wraps an async handler so a rejected promise reaches Express's error handler. */
const route = (handler) => (req, res, nextFn) => Promise.resolve(handler(req, res)).catch(nextFn);

function field(body, key) {
  const value = body?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEmail(value) {
  return value.toLowerCase();
}

function normalizeTeamCode(value) {
  return value.replace(/\s+/g, "").toUpperCase();
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function makeTeamCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";

  for (let index = 0; index < 6; index += 1) {
    suffix += alphabet[randomInt(alphabet.length)];
  }

  return `HG-${suffix}`;
}

/** Leadership lives on teams.leaderId, so a member's role is derived. */
function toTeamView(team) {
  return {
    id: team.id,
    name: team.name,
    code: team.code,
    members: team.members.map((member) => ({
      id: member.userId,
      name: member.user.name,
      email: member.user.email,
      role: member.userId === team.leaderId ? "LEADER" : "MEMBER",
      joinOrder: member.joinOrder,
    })),
  };
}

function validationError(message) {
  return { status: "error", message };
}

function databaseError(error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "EACCES") {
    return validationError("Could not reach the database from the server. Check its network access.");
  }
  console.error("[teams] database request failed:", error);
  return validationError("Database request failed. Try again.");
}

export function createTeamsRouter({ prisma, dev }) {
  const router = Router();

  async function findTeamForEmail(email) {
    return prisma.team.findFirst({
      where: { members: { some: { user: { email } } } },
      orderBy: { createdAt: "desc" },
      include: teamInclude,
    });
  }

  async function lookupByEmail(emailValue) {
    const email = normalizeEmail(emailValue);

    if (!isEmail(email)) {
      return { status: "idle", message: "" };
    }

    const team = await findTeamForEmail(email);

    if (!team) {
      return { status: "idle", message: "" };
    }

    const view = toTeamView(team);
    const viewer = view.members.find((member) => member.email === email);

    return {
      status: "success",
      message: "Team loaded.",
      viewerRole: viewer?.role ?? "MEMBER",
      team: view,
    };
  }

  async function createTeam(body) {
    const teamName = field(body, "teamName");
    const leaderName = field(body, "leaderName");
    const email = normalizeEmail(field(body, "email"));
    const leaderAccepted = body?.leaderAccepted === true || body?.leaderAccepted === "on";

    if (!teamName) {
      return validationError("Enter a team name.");
    }

    if (!leaderName) {
      return validationError("Enter your name.");
    }

    if (!isEmail(email)) {
      return validationError("Enter a valid Gmail address.");
    }

    if (!leaderAccepted) {
      return validationError("Confirm that creating a team makes you the team leader.");
    }

    const existing = await findTeamForEmail(email);

    if (existing) {
      return validationError("That email is already in a team.");
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const team = await prisma.$transaction(async (tx) => {
          const leader = await tx.user.upsert({
            where: { email },
            update: { name: leaderName },
            create: { email, name: leaderName },
          });

          return tx.team.create({
            data: {
              name: teamName,
              code: makeTeamCode(),
              leaderId: leader.id,
              members: { create: { userId: leader.id, joinOrder: 1 } },
            },
            include: teamInclude,
          });
        });

        return {
          status: "success",
          message: "Team created. Share the team code with your members.",
          viewerRole: "LEADER",
          team: toTeamView(team),
        };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          attempt < 4
        ) {
          continue;
        }

        throw error;
      }
    }

    return validationError("Could not create a unique team code. Try again.");
  }

  async function joinTeam(body) {
    const code = normalizeTeamCode(field(body, "teamCode"));
    const memberName = field(body, "memberName");
    const email = normalizeEmail(field(body, "email"));

    if (!code) {
      return validationError("Enter a team code.");
    }

    if (!memberName) {
      return validationError("Enter your name.");
    }

    if (!isEmail(email)) {
      return validationError("Enter a valid Gmail address.");
    }

    const existingTeam = await prisma.team.findUnique({
      where: { code },
      include: teamInclude,
    });

    if (!existingTeam) {
      return validationError("No team found for that code.");
    }

    const alreadyIn = existingTeam.members.find((member) => member.user.email === email);

    if (alreadyIn) {
      return {
        status: "success",
        message: "You are already in this team.",
        viewerRole: alreadyIn.userId === existingTeam.leaderId ? "LEADER" : "MEMBER",
        team: toTeamView(existingTeam),
      };
    }

    if (existingTeam.members.length >= maxTeamMembers) {
      return validationError("This team is full. A team can have at most 6 people.");
    }

    const elsewhere = await findTeamForEmail(email);

    if (elsewhere) {
      return validationError("That email is already in another team.");
    }

    const nextJoinOrder =
      existingTeam.members.reduce((highest, member) => Math.max(highest, member.joinOrder), 0) + 1;

    const team = await prisma.$transaction(async (tx) => {
      const user = await tx.user.upsert({
        where: { email },
        update: { name: memberName },
        create: { email, name: memberName },
      });

      await tx.teamMember.create({
        data: { teamId: existingTeam.id, userId: user.id, joinOrder: nextJoinOrder },
      });

      return tx.team.findUniqueOrThrow({ where: { id: existingTeam.id }, include: teamInclude });
    });

    return {
      status: "success",
      message: "Joined team. Team members are listed in joining order.",
      viewerRole: "MEMBER",
      team: toTeamView(team),
    };
  }

  // The team an email belongs to, if any. `idle` when there is none — the
  // frontend treats that as "show the create / join cards".
  router.get(
    "/by-email/:email",
    route(async (req, res) => {
      try {
        res.json(await lookupByEmail(req.params.email));
      } catch (error) {
        res.status(500).json(databaseError(error));
      }
    }),
  );

  // One endpoint for both forms, matching the single server action that used
  // to handle them. `intent` picks the branch.
  router.post(
    "/submit",
    route(async (req, res) => {
      const intent = field(req.body, "intent");
      try {
        if (intent === "create") return res.json(await createTeam(req.body));
        if (intent === "join") return res.json(await joinTeam(req.body));
        res.status(400).json(validationError("Choose whether you want to create or join a team."));
      } catch (error) {
        res.status(500).json(databaseError(error));
      }
    }),
  );

  /**
   * Everyone in the users table, for the development-only "act as" picker on
   * the teams page. Empty in production: nothing there lists other people.
   */
  router.get(
    "/users",
    route(async (_req, res) => {
      if (!dev) return res.json([]);

      try {
        const users = await prisma.user.findMany({
          orderBy: { name: "asc" },
          relationLoadStrategy: "join",
          include: {
            memberships: {
              orderBy: { joinedAt: "desc" },
              take: 1,
              select: { team: { select: { name: true, leaderId: true } } },
            },
          },
        });

        res.json(
          users.map((user) => {
            const team = user.memberships[0]?.team ?? null;
            return {
              id: user.id,
              name: user.name,
              email: user.email,
              role: team ? (team.leaderId === user.id ? "LEADER" : "MEMBER") : null,
              teamName: team?.name ?? null,
            };
          }),
        );
      } catch (error) {
        console.error("[teams] listUsers failed:", error);
        res.json([]);
      }
    }),
  );

  return router;
}
