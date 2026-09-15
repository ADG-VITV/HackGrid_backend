/**
 * Capsule and pod lifecycle.
 *
 * Plain JS and free of any transport concerns, so the REST routers (an
 * organiser pressing Start) and the websocket hub drive the event through the
 * same code.
 *
 * The event runs strictly one capsule at a time, in catalogue order. A capsule
 * opens only when the organiser starts it (Force in development, the admin
 * portal in production); nothing opens on its own when the one before it
 * finishes.
 *
 * The organiser flow is:
 *   1. Start event -> create every capsule plus pod assignments for all rounds
 *   2. Start a round -> open that prepared capsule for bidding
 *   3. Reset round / tier -> rewind that prepared data without touching schema
 *
 * Pods are drawn once, at Start event, and survive round resets — so the admin
 * portal can show every round's seating ahead of time. The bidding page still
 * only ever loads the seat for the round that is live.
 */

import { randomInt, randomUUID } from "node:crypto";
import {
  auctionTiles,
  capsuleOrder,
  findTile,
  nextCapsuleKey,
  reserveAfter,
  sequenceOf,
} from "./auction-catalog.mjs";
import { STARTING_BALANCE, spendingCapFor } from "./auction-rules.mjs";

export const EVENT_KEY = "hackgrid-default";

/** Fisher-Yates with a CSPRNG, so pods aren't reproducible between rounds. */
function shuffle(input) {
  const items = [...input];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function defaultCapsuleView(tile, index) {
  return {
    key: tile.id,
    name: tile.label,
    sequenceOrder: index + 1,
    capsuleId: null,
    status: "PENDING",
    tierCount: tile.items.length,
  };
}

function buildGroups(teams, podSize) {
  const ordered = shuffle(teams);
  const mainPodCount = Math.floor(ordered.length / podSize);
  const groups = [];

  for (let index = 0; index < mainPodCount; index += 1) {
    groups.push({
      kind: "MAIN",
      teams: ordered.slice(index * podSize, (index + 1) * podSize),
    });
  }

  const leftover = ordered.slice(mainPodCount * podSize);
  if (leftover.length > 0) {
    groups.push({ kind: "REMAINDER", teams: leftover });
  }

  return groups;
}

function firstBiddableRank(subCapsules, fromRank = 1) {
  return (
    subCapsules.find((subCapsule) => subCapsule.tierRank >= fromRank && !subCapsule.isAutoAssigned)
      ?.tierRank ?? null
  );
}

function buildPreparedRows(capsule, groups, { openFromRank = null } = {}) {
  let podNumber = 0;
  const podRows = groups.map((group) => ({
    id: randomUUID(),
    capsuleId: capsule.id,
    label: `Pod ${(podNumber += 1)}`,
    kind: group.kind,
  }));

  const membershipRows = groups.flatMap((group, groupIndex) =>
    group.teams.map((team, seat) => ({
      id: randomUUID(),
      podId: podRows[groupIndex].id,
      capsuleId: capsule.id,
      teamId: team.id,
      teamName: team.name,
      teamCode: team.code,
      leadName: team.leader.name,
      leadEmail: team.leader.email,
      seat: seat + 1,
    })),
  );

  const lotRows = podRows.flatMap((pod, groupIndex) =>
    capsule.subCapsules.map((subCapsule) => ({
      id: randomUUID(),
      podId: pod.id,
      subCapsuleId: subCapsule.id,
      tierRank: subCapsule.tierRank,
      status:
        groups[groupIndex].kind === "MAIN" && openFromRank === subCapsule.tierRank ? "OPEN" : "PENDING",
      openedAt: null,
      closesAt: null,
      frozenPrice: null,
      topBidId: null,
    })),
  );

  return { podRows, membershipRows, lotRows };
}

export async function ensureEvent(prisma) {
  const event = await prisma.event.upsert({
    where: { key: EVENT_KEY },
    update: { startingBudget: STARTING_BALANCE },
    create: { key: EVENT_KEY, name: "HackGrid", startingBudget: STARTING_BALANCE },
  });

  // Teams seeded before the event table existed have no event yet.
  await prisma.team.updateMany({ where: { eventId: null }, data: { eventId: event.id } });
  await normalizePodConfiguration(prisma, event.id);
  return event;
}

/**
 * Make the capsule and its tiers match the catalogue. Idempotent, so Start can
 * prepare from an empty database with no extra seed step.
 */
export async function ensureCapsule(prisma, eventId, capsuleKey) {
  const tile = findTile(capsuleKey);
  if (!tile) return null;

  const capsule = await prisma.capsule.upsert({
    where: { eventId_key: { eventId, key: capsuleKey } },
    update: { name: tile.label, sequenceOrder: sequenceOf(capsuleKey) },
    create: {
      eventId,
      key: capsuleKey,
      name: tile.label,
      sequenceOrder: sequenceOf(capsuleKey),
    },
  });

  await Promise.all(
    tile.items.map((item, index) => {
      const data = {
        name: item.name,
        tierRank: index + 1,
        startingBid: item.price,
        minIncrement: item.minIncrement,
        isAutoAssigned: item.minIncrement === null,
      };
      return prisma.subCapsule.upsert({
        where: { capsuleId_key: { capsuleId: capsule.id, key: item.key } },
        update: data,
        create: { capsuleId: capsule.id, key: item.key, ...data },
      });
    }),
  );

  return prisma.capsule.findUniqueOrThrow({
    where: { id: capsule.id },
    relationLoadStrategy: "join",
    include: { subCapsules: { orderBy: { tierRank: "asc" } } },
  });
}

async function ensureAllCapsules(prisma, eventId) {
  const prepared = await Promise.all(capsuleOrder.map((capsuleKey) => ensureCapsule(prisma, eventId, capsuleKey)));
  return prepared.filter(Boolean);
}

async function eventTeams(prisma, eventId) {
  return prisma.team.findMany({
    where: { eventId },
    relationLoadStrategy: "join",
    include: { leader: true },
    orderBy: { id: "asc" },
  });
}

async function podIdsForCapsule(prisma, capsuleId) {
  const pods = await prisma.pod.findMany({
    where: { capsuleId },
    orderBy: [{ kind: "asc" }, { label: "asc" }],
    select: { id: true, kind: true },
  });

  return pods;
}

/**
 * Older events named the final pod "Remainder Pod". Pod identity is now
 * always numeric; remainder is solely the pod's kind/flag. This is an
 * idempotent data repair, so existing rooms, memberships, lots and bids keep
 * their ids while their display/search label becomes Pod N.
 */
async function normalizePodConfiguration(prisma, eventId) {
  const pods = await prisma.pod.findMany({
    where: { capsule: { eventId } },
    select: { id: true, capsuleId: true, label: true, kind: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const byCapsule = new Map();
  for (const pod of pods) {
    const group = byCapsule.get(pod.capsuleId) ?? [];
    group.push(pod);
    byCapsule.set(pod.capsuleId, group);
  }

  const temporaryLabelChanges = [];
  const finalLabelChanges = [];
  const kindChanges = [];
  for (const capsulePods of byCapsule.values()) {
    // Preserve the first occurrence of every valid pod number, then give all
    // legacy or duplicate labels a fresh number. This also canonicalizes
    // spelling and spacing (for example, "pod 13" becomes "Pod 13").
    const assignedNumbers = new Set();
    const targets = new Map();
    let largestPodNumber = 0;

    for (const pod of capsulePods) {
      const match = /^Pod\s+(\d+)\s*$/i.exec(pod.label);
      const podNumber = match ? Number(match[1]) : Number.NaN;
      if (Number.isSafeInteger(podNumber) && podNumber > 0 && !assignedNumbers.has(podNumber)) {
        targets.set(pod.id, podNumber);
        assignedNumbers.add(podNumber);
        largestPodNumber = Math.max(largestPodNumber, podNumber);
      }
    }

    let nextPodNumber = largestPodNumber + 1;
    for (const pod of capsulePods) {
      if (!targets.has(pod.id)) {
        targets.set(pod.id, nextPodNumber);
        nextPodNumber += 1;
      }

      const label = `Pod ${targets.get(pod.id)}`;
      if (pod.label !== label) {
        // Move every affected label aside first. A legacy case/spacing variant
        // can otherwise collide with the canonical label of another pod.
        temporaryLabelChanges.push(
          prisma.pod.update({ where: { id: pod.id }, data: { label: `__pod-normalizing-${pod.id}` } }),
        );
        finalLabelChanges.push(prisma.pod.update({ where: { id: pod.id }, data: { label } }));
      }
    }

    // The current manager permits exactly one lucky/remainder flag per round.
    // Keep the earliest legacy flag and safely unflag any old duplicates.
    const remainders = capsulePods.filter((pod) => pod.kind === "REMAINDER");
    for (const pod of remainders.slice(1)) {
      kindChanges.push(prisma.pod.update({ where: { id: pod.id }, data: { kind: "MAIN" } }));
    }
  }

  if (temporaryLabelChanges.length + kindChanges.length > 0) {
    await prisma.$transaction([...temporaryLabelChanges, ...finalLabelChanges, ...kindChanges]);
  }
}

async function prepareCapsulePods(prisma, capsule, teams) {
  const groups = buildGroups(teams, capsule.subCapsules.length);
  const { podRows, membershipRows, lotRows } = buildPreparedRows(capsule, groups);

  await prisma.$transaction(
    [
      prisma.roundTierPrice.deleteMany({ where: { capsuleId: capsule.id } }),
      prisma.pod.deleteMany({ where: { capsuleId: capsule.id } }),
      prisma.pod.createMany({ data: podRows }),
      prisma.podMembership.createMany({ data: membershipRows }),
      prisma.lot.createMany({ data: lotRows }),
      prisma.capsule.update({
        where: { id: capsule.id },
        data: { status: "PENDING", startedAt: null },
      }),
    ],
    { timeout: 30_000 },
  );

  return {
    podCount: podRows.length,
    memberCount: membershipRows.length,
  };
}

export async function startEvent(prisma) {
  const event = await ensureEvent(prisma);
  const [capsules, teams, live, settlements, existingPods] = await Promise.all([
    ensureAllCapsules(prisma, event.id),
    eventTeams(prisma, event.id),
    prisma.capsule.findFirst({
      where: { eventId: event.id, status: "LIVE" },
      select: { name: true },
    }),
    prisma.settlement.count({ where: { capsule: { eventId: event.id } } }),
    prisma.pod.count({ where: { capsule: { eventId: event.id } } }),
  ]);

  if (teams.length === 0) {
    return {
      status: "error",
      message: "No teams found for this event. Create teams on /teams first.",
    };
  }

  if (live) {
    return {
      status: "error",
      message: `${live.name} is already live.`,
    };
  }

  if (settlements > 0) {
    return {
      status: "error",
      message: "This event already has settled results. Reset the event before preparing it again.",
    };
  }

  if (existingPods > 0) {
    return {
      status: "error",
      message: "This event is already prepared. Reset it first if you need fresh pod assignments.",
    };
  }

  let totalPods = 0;
  for (const capsule of capsules) {
    const result = await prepareCapsulePods(prisma, capsule, teams);
    totalPods += result.podCount;
  }

  return {
    status: "success",
    message: `Prepared ${capsules.length} round(s) for ${teams.length} team(s) with ${totalPods} pod(s).`,
  };
}

/**
 * Open a prepared capsule. Start Event should already have drawn its pods; the
 * force path exists only for development convenience.
 */
export async function startCapsule(prisma, capsuleKey, { force = false } = {}) {
  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);

  if (!capsule) {
    return { status: "error", message: `Unknown capsule "${capsuleKey}".` };
  }

  const [live, pods, teams, bids, settlements, teamCount, capsuleRows] = await Promise.all([
    prisma.capsule.findFirst({
      where: { eventId: event.id, status: "LIVE" },
      select: { id: true, key: true, name: true },
    }),
    podIdsForCapsule(prisma, capsule.id),
    force ? eventTeams(prisma, event.id) : Promise.resolve([]),
    prisma.bid.count({ where: { lot: { pod: { capsuleId: capsule.id } } } }),
    prisma.settlement.count({ where: { capsuleId: capsule.id } }),
    prisma.podMembership.count({ where: { capsuleId: capsule.id } }),
    prisma.capsule.findMany({
      where: { eventId: event.id },
      select: { key: true, status: true, sequenceOrder: true },
      orderBy: { sequenceOrder: "asc" },
    }),
  ]);

  if (live?.id === capsule.id) {
    return { status: "error", message: `${capsule.name} is already live.` };
  }

  // The admin portal opens rounds strictly in order, one at a time. Force is
  // the development shortcut: it closes whichever round was live and opens
  // this one in its place.
  if (live && !force) {
    return { status: "error", message: `${live.name} is already live. Finish or reset it first.` };
  }

  if (!force) {
    const previous = capsuleRows.filter((row) => row.sequenceOrder < capsule.sequenceOrder);
    const blockedBy = previous.find((row) => row.status !== "CLOSED");
    if (blockedBy) {
      return {
        status: "error",
        message: `Finish ${findTile(blockedBy.key)?.label ?? blockedBy.key} before starting ${capsule.name}.`,
      };
    }
  }

  if (bids > 0 || settlements > 0) {
    return {
      status: "error",
      message: `${capsule.name} already has recorded bidding. Reset that round before starting it again.`,
    };
  }

  let preparedPods = pods;
  let preparedTeamCount = teamCount;
  if (preparedPods.length === 0) {
    if (!force) {
      return {
        status: "error",
        message: "Start event first so pod assignments exist for every round.",
      };
    }

    if (teams.length === 0) {
      return {
        status: "error",
        message: "No teams found for this event. Create teams on /teams first.",
      };
    }

    await prepareCapsulePods(prisma, capsule, teams);
    preparedPods = await podIdsForCapsule(prisma, capsule.id);
    preparedTeamCount = teams.length;
  }

  const openingRank = firstBiddableRank(capsule.subCapsules);

  await prisma.$transaction(
    [
      // Strictly one capsule at a time: with `force`, opening this one ends
      // whichever was still live. Its pods and results stay exactly as they
      // were. Without `force` the guard above has already refused, so this
      // matches nothing.
      prisma.capsule.updateMany({
        where: { eventId: event.id, status: "LIVE", id: { not: capsule.id } },
        data: { status: "CLOSED" },
      }),
      prisma.roundTierPrice.deleteMany({ where: { capsuleId: capsule.id } }),
      prisma.lot.updateMany({
        where: { pod: { capsuleId: capsule.id } },
        data: { status: "PENDING", openedAt: null, closesAt: null, frozenPrice: null, topBidId: null },
      }),
      ...(openingRank === null
        ? []
        : [
            prisma.lot.updateMany({
              where: {
                podId: { in: preparedPods.filter((pod) => pod.kind === "MAIN").map((pod) => pod.id) },
                tierRank: openingRank,
              },
              data: { status: "OPEN", openedAt: null, closesAt: null },
            }),
          ]),
      prisma.capsule.update({
        where: { id: capsule.id },
        data: { status: "LIVE", startedAt: new Date() },
      }),
    ],
    { timeout: 30_000 },
  );

  return {
    status: "success",
    capsuleId: capsule.id,
    capsuleKey: capsule.key,
    capsuleName: capsule.name,
    podSize: capsule.subCapsules.length,
    teamCount: preparedTeamCount,
    podCount: preparedPods.length,
    hasRemainderPod: preparedPods.some((pod) => pod.kind === "REMAINDER"),
    message: `${capsule.name} is live with ${preparedPods.length} prepared pod(s).`,
  };
}

/**
 * Freeze the price remainder pods pay, then open their tiers.
 *
 * The price is the average of what each tier actually sold for across the main
 * pods, snapshotted now. With too few teams for any main pod to have formed,
 * the listed starting bid stands in.
 */
export async function openRemainderPod(prisma, capsuleId) {
  const [remainderPods, subCapsules, mainSettlements] = await Promise.all([
    prisma.pod.findMany({ where: { capsuleId, kind: "REMAINDER" }, select: { id: true } }),
    prisma.subCapsule.findMany({ where: { capsuleId }, orderBy: { tierRank: "asc" } }),
    prisma.settlement.findMany({
      where: { capsuleId, lot: { pod: { kind: "MAIN" } } },
      select: { subCapsuleId: true, pricePaid: true },
    }),
  ]);

  if (remainderPods.length === 0) return null;

  const totals = new Map();
  for (const settlement of mainSettlements) {
    const entry = totals.get(settlement.subCapsuleId) ?? { sum: 0, count: 0 };
    entry.sum += settlement.pricePaid;
    entry.count += 1;
    totals.set(settlement.subCapsuleId, entry);
  }

  const priceRows = subCapsules.map((subCapsule) => {
    const entry = totals.get(subCapsule.id);
    if (!entry || entry.count === 0) {
      return {
        capsuleId,
        subCapsuleId: subCapsule.id,
        avgPrice: subCapsule.startingBid,
        podsCounted: 0,
        source: "STARTING_BID_FALLBACK",
      };
    }

    return {
      capsuleId,
      subCapsuleId: subCapsule.id,
      avgPrice: Math.round(entry.sum / entry.count),
      podsCounted: entry.count,
      source: "POD_AVERAGE",
    };
  });

  const priceBySubCapsule = new Map(priceRows.map((row) => [row.subCapsuleId, row.avgPrice]));
  const lots = await prisma.lot.findMany({
    where: { podId: { in: remainderPods.map((pod) => pod.id) }, status: "PENDING" },
    select: { id: true, podId: true, subCapsuleId: true },
  });

  await prisma.$transaction(
    [
      prisma.roundTierPrice.deleteMany({ where: { capsuleId } }),
      prisma.roundTierPrice.createMany({ data: priceRows }),
      ...lots.map((lot) =>
        prisma.lot.update({
          where: { id: lot.id },
          data: {
            status: "OPEN",
            openedAt: null,
            closesAt: null,
            frozenPrice: priceBySubCapsule.get(lot.subCapsuleId) ?? 0,
          },
        }),
      ),
    ],
    { timeout: 30_000 },
  );

  return {
    podIds: remainderPods.map((pod) => pod.id),
    lotIds: lots.map((lot) => lot.id),
    prices: priceRows,
  };
}

/**
 * Mark a capsule finished once every lot in it is settled, and report which
 * capsule should open next.
 */
export async function closeCapsuleIfDone(prisma, capsuleId) {
  const [capsule, unfinished, total] = await Promise.all([
    prisma.capsule.findUnique({ where: { id: capsuleId }, select: { key: true, status: true } }),
    prisma.lot.count({ where: { pod: { capsuleId }, status: { not: "CLOSED" } } }),
    prisma.lot.count({ where: { pod: { capsuleId } } }),
  ]);

  if (!capsule) return { closed: false, nextKey: null };
  if (capsule.status === "CLOSED") return { closed: false, nextKey: nextCapsuleKey(capsule.key) };

  if (capsule.status !== "LIVE" || total === 0 || unfinished > 0) {
    return { closed: false, nextKey: null };
  }

  await prisma.capsule.update({ where: { id: capsuleId }, data: { status: "CLOSED" } });
  return { closed: true, nextKey: nextCapsuleKey(capsule.key) };
}

/** True once every main pod in the capsule has settled all of its lots. */
export async function mainPodsFinished(prisma, capsuleId) {
  const outstanding = await prisma.lot.count({
    where: { pod: { capsuleId, kind: "MAIN" }, status: { not: "CLOSED" } },
  });
  return outstanding === 0;
}

/** Capsules with their running order and status, for the bidding page. */
export async function listCapsules(prisma) {
  const rows = await prisma.capsule.findMany({
    where: { event: { key: EVENT_KEY } },
    select: { id: true, key: true, status: true, sequenceOrder: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return auctionTiles.map((tile, index) => {
    const row = byKey.get(tile.id);
    return {
      ...defaultCapsuleView(tile, index),
      capsuleId: row?.id ?? null,
      status: row?.status ?? "PENDING",
    };
  });
}

/** Look a team up by numeric id or by any member's email. */
export async function findTeamByIdOrEmail(prisma, value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  return trimmed.includes("@")
    ? prisma.team.findFirst({
        where: { members: { some: { user: { email: trimmed.toLowerCase() } } } },
        relationLoadStrategy: "join",
        include: { leader: true },
      })
    : prisma.team.findUnique({
        where: { id: Number.parseInt(trimmed, 10) },
        relationLoadStrategy: "join",
        include: { leader: true },
      });
}

/**
 * Everything a viewer needs: the running order, their seat in the round that is
 * actually live, and the resources their team already owns.
 */
export async function getBiddingContext(prisma, teamIdOrEmail) {
  await ensureEvent(prisma);
  const value = String(teamIdOrEmail ?? "").trim();

  const [capsuleRows, team] = await Promise.all([
    listCapsules(prisma),
    value ? findTeamByIdOrEmail(prisma, value) : Promise.resolve(null),
  ]);

  const capsules = capsuleRows.map((row) => ({
    ...row,
    podId: null,
    podLabel: null,
    podKind: null,
  }));

  if (!value) {
    return {
      status: "success",
      message: "",
      team: null,
      viewerRole: null,
      currentLot: null,
      capsules,
      resources: null,
    };
  }

  if (!team) {
    return {
      status: "error",
      message: "No team found for that identity.",
      team: null,
      viewerRole: null,
      currentLot: null,
      capsules,
      resources: null,
    };
  }

  // Who is asking. Only the lead bids (rulebook 8); everyone else on the
  // roster gets a read-only view. A numeric id is the dev "act as" picker,
  // which always plays the lead.
  const viewerRole =
    value.includes("@") && value.toLowerCase() !== team.leader.email.toLowerCase()
      ? "MEMBER"
      : "LEADER";

  // Latest in the running order wins if more than one is somehow live.
  const live = capsules.findLast((capsule) => capsule.status === "LIVE") ?? null;

  const [membership, settlements] = await Promise.all([
    live?.capsuleId
      ? prisma.podMembership.findUnique({
          where: { capsuleId_teamId: { capsuleId: live.capsuleId, teamId: team.id } },
          relationLoadStrategy: "join",
          select: {
            podId: true,
            pod: {
              select: {
                label: true,
                kind: true,
                // The tier on the block right now, so a member can see what
                // their lead is bidding on without joining the pod room.
                lots: {
                  where: { status: "OPEN" },
                  take: 1,
                  select: {
                    tierRank: true,
                    closesAt: true,
                    subCapsule: { select: { name: true } },
                  },
                },
              },
            },
          },
        })
      : Promise.resolve(null),
    prisma.settlement.findMany({
      where: { teamId: team.id },
      relationLoadStrategy: "join",
      select: {
        pricePaid: true,
        priceSource: true,
        settledAt: true,
        capsule: { select: { key: true, name: true, sequenceOrder: true } },
        subCapsule: { select: { name: true } },
      },
    }),
  ]);

  const owned = settlements
    .map((settlement) => ({
      capsuleKey: settlement.capsule.key,
      capsuleName: settlement.capsule.name,
      sequenceOrder: settlement.capsule.sequenceOrder,
      tierName: settlement.subCapsule.name,
      pricePaid: settlement.pricePaid,
      priceSource: settlement.priceSource,
      settledAt: settlement.settledAt.toISOString(),
    }))
    .sort((left, right) => left.sequenceOrder - right.sequenceOrder);

  const spent = owned.reduce((total, row) => total + row.pricePaid, 0);
  const remaining = STARTING_BALANCE - spent;

  // The capsule this team is (or will next be) bidding in: the live one, else
  // the first that has not closed. Its reserve is what the team must hold back.
  const current =
    live ?? capsules.find((capsule) => capsule.status !== "CLOSED") ?? capsules.at(-1) ?? null;
  const reserve = current ? reserveAfter(current.key) : 0;

  const openLot = membership?.pod.lots[0] ?? null;

  return {
    status: "success",
    message: "",
    team: {
      id: team.id,
      name: team.name,
      code: team.code,
      leadName: team.leader.name,
      leadEmail: team.leader.email,
    },
    viewerRole,
    currentLot: openLot
      ? {
          name: openLot.subCapsule.name,
          tierRank: openLot.tierRank,
          closesAt: openLot.closesAt ? openLot.closesAt.toISOString() : null,
        }
      : null,
    capsules: capsules.map((capsule) =>
      capsule.key === live?.key
        ? {
            ...capsule,
            podId: membership?.podId ?? null,
            podLabel: membership?.pod.label ?? null,
            podKind: membership?.pod.kind ?? null,
          }
        : capsule,
    ),
    resources: {
      teamId: team.id,
      teamName: team.name,
      teamCode: team.code,
      leadName: team.leader.name,
      leadEmail: team.leader.email,
      startingBudget: STARTING_BALANCE,
      spent,
      remaining,
      reserve,
      spendingCap: spendingCapFor({ remainingBalance: remaining, reserve }),
      reserveCapsuleKey: current?.key ?? null,
      owned,
    },
  };
}

export async function getAdminEventContext(prisma) {
  const [event, teams] = await Promise.all([
    prisma.event.findUnique({
      where: { key: EVENT_KEY },
      select: { id: true, startingBudget: true },
    }),
    prisma.team.findMany({
      orderBy: { id: "asc" },
      relationLoadStrategy: "join",
      include: { leader: { select: { name: true, email: true } } },
    }),
  ]);

  if (event) await normalizePodConfiguration(prisma, event.id);

  const capsuleRows = event
    ? await prisma.capsule.findMany({
        where: { eventId: event.id },
        relationLoadStrategy: "join",
        orderBy: { sequenceOrder: "asc" },
        include: {
          subCapsules: { orderBy: { tierRank: "asc" } },
          pods: {
            orderBy: [{ kind: "asc" }, { label: "asc" }],
            include: {
              memberships: { orderBy: { seat: "asc" } },
              lots: {
                orderBy: { tierRank: "asc" },
                include: {
                  subCapsule: { select: { name: true } },
                  settlement: {
                    select: { teamId: true, pricePaid: true, priceSource: true },
                  },
                },
              },
            },
          },
          _count: {
            select: {
              pods: true,
              memberships: true,
              settlements: true,
            },
          },
        },
      })
    : [];

  const byKey = new Map(capsuleRows.map((capsule) => [capsule.key, capsule]));
  const capsules = auctionTiles.map((tile, index) => {
    const capsule = byKey.get(tile.id);
    const pods =
      capsule?.pods.map((pod) => {
        const openLot = pod.lots.find((lot) => lot.status === "OPEN") ?? null;
        const allLotsClosed = pod.lots.length > 0 && pod.lots.every((lot) => lot.status === "CLOSED");
        const auctionStatus = allLotsClosed
          ? "COMPLETE"
          : openLot?.closesAt
            ? "LIVE"
            : openLot
              ? "WAITING_FOR_TEAMS"
              : "PENDING";
        const itemByTeamId = new Map(
          pod.lots
            .filter((lot) => lot.settlement)
            .map((lot) => [lot.settlement.teamId, {
              name: lot.subCapsule.name,
              tierRank: lot.tierRank,
              pricePaid: lot.settlement.pricePaid,
              priceSource: lot.settlement.priceSource,
            }]),
        );

        return {
          id: pod.id,
          label: pod.label,
          kind: pod.kind,
          auctionStatus,
          activeItemName: openLot?.subCapsule.name ?? null,
          settledLots: pod.lots.filter((lot) => lot.status === "CLOSED").length,
          lotCount: pod.lots.length,
          teams: pod.memberships.map((membership) => ({
            id: membership.teamId,
            name: membership.teamName,
            code: membership.teamCode,
            leadName: membership.leadName,
            leadEmail: membership.leadEmail,
            seat: membership.seat,
            item: itemByTeamId.get(membership.teamId) ?? null,
          })),
        };
      }) ?? [];
    return {
      key: tile.id,
      name: tile.label,
      status: capsule?.status ?? "PENDING",
      sequenceOrder: index + 1,
      podCount: capsule?._count.pods ?? 0,
      memberCount: capsule?._count.memberships ?? 0,
      settlementCount: capsule?._count.settlements ?? 0,
      pods,
      subCapsules:
        capsule?.subCapsules.map((subCapsule) => ({
          key: subCapsule.key,
          name: subCapsule.name,
          tierRank: subCapsule.tierRank,
          isAutoAssigned: subCapsule.isAutoAssigned,
        })) ??
        tile.items.map((item, itemIndex) => ({
          key: item.key,
          name: item.name,
          tierRank: itemIndex + 1,
          isAutoAssigned: item.minIncrement === null,
        })),
    };
  });

  const liveCapsule = capsules.find((capsule) => capsule.status === "LIVE") ?? null;

  return {
    teamCount: teams.length,
    teams: teams.map((team) => ({
      id: team.id,
      name: team.name,
      code: team.code,
      leadName: team.leader.name,
      leadEmail: team.leader.email,
    })),
    event: {
      startingBudget: event?.startingBudget ?? STARTING_BALANCE,
      preparedCapsules: capsules.filter((capsule) => capsule.podCount > 0).length,
      completedCapsules: capsules.filter((capsule) => capsule.status === "CLOSED").length,
      liveCapsuleKey: liveCapsule?.key ?? null,
      liveCapsuleName: liveCapsule?.name ?? null,
      isPrepared: capsules.every((capsule) => capsule.podCount > 0),
    },
    capsules,
  };
}

function podLotRows(capsule, podId) {
  return capsule.subCapsules.map((subCapsule) => ({
    id: randomUUID(),
    podId,
    subCapsuleId: subCapsule.id,
    tierRank: subCapsule.tierRank,
    status: "PENDING",
    openedAt: null,
    closesAt: null,
    frozenPrice: null,
    topBidId: null,
  }));
}

async function editablePod(prisma, capsuleKey, podId) {
  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);
  if (!capsule) return { error: `Unknown capsule "${capsuleKey}".` };
  if (capsule.status !== "PENDING") {
    return { error: "Pod assignments can only be changed before this round starts." };
  }

  const pod = await prisma.pod.findFirst({
    where: { id: podId, capsuleId: capsule.id },
    select: { id: true, capsuleId: true, label: true, kind: true },
  });
  if (!pod) return { error: "That pod does not belong to the selected round." };
  return { capsule, pod };
}

/** Create an empty, manually managed pod inside a prepared pending round. */
export async function createManualPod(prisma, capsuleKey, podNumber, kind = "MAIN") {
  if (!Number.isInteger(podNumber) || podNumber < 1) {
    return { status: "error", message: "Enter a whole pod number starting at 1." };
  }
  if (kind !== "MAIN" && kind !== "REMAINDER") {
    return { status: "error", message: "Choose either a standard or remainder pod." };
  }

  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);
  if (!capsule) return { status: "error", message: `Unknown capsule "${capsuleKey}".` };
  if (capsule.status !== "PENDING") {
    return { status: "error", message: "New pods can only be created before this round starts." };
  }

  const preparedPods = await prisma.pod.count({ where: { capsule: { eventId: event.id } } });
  if (preparedPods === 0) {
    return { status: "error", message: "Start the event first to prepare the round roster, then create manual pods." };
  }

  const label = `Pod ${podNumber}`;
  const exists = await prisma.pod.findFirst({ where: { capsuleId: capsule.id, label }, select: { id: true } });
  if (exists) return { status: "error", message: `${label} already exists in ${capsule.name}.` };

  if (kind === "REMAINDER") {
    const existingRemainder = await prisma.pod.findFirst({
      where: { capsuleId: capsule.id, kind: "REMAINDER" },
      select: { label: true },
    });
    if (existingRemainder) {
      return {
        status: "error",
        message: `${existingRemainder.label} is already this round's lucky / remainder pod. Only one is allowed.`,
      };
    }
  }

  const podId = randomUUID();
  await prisma.$transaction([
    prisma.pod.create({ data: { id: podId, capsuleId: capsule.id, label, kind } }),
    prisma.lot.createMany({ data: podLotRows(capsule, podId) }),
  ]);

  return { status: "success", message: `${label} was created in ${capsule.name}.`, podId };
}

/** Add an unseated team to a manually configured pending-round pod. */
export async function addTeamToPod(prisma, capsuleKey, podId, teamId) {
  if (!Number.isInteger(teamId)) return { status: "error", message: "Choose a valid team." };
  const result = await editablePod(prisma, capsuleKey, podId);
  if ("error" in result) return { status: "error", message: result.error };

  const [team, existing] = await Promise.all([
    prisma.team.findUnique({
      where: { id: teamId },
      relationLoadStrategy: "join",
      include: { leader: { select: { name: true, email: true } } },
    }),
    prisma.podMembership.findUnique({ where: { capsuleId_teamId: { capsuleId: result.capsule.id, teamId } } }),
  ]);
  if (!team) return { status: "error", message: "That team no longer exists." };
  if (existing) return { status: "error", message: `${team.name} is already seated in this round. Remove it from its current pod first.` };

  const highestSeat = await prisma.podMembership.aggregate({
    where: { podId },
    _max: { seat: true },
  });
  await prisma.podMembership.create({
    data: {
      id: randomUUID(),
      podId,
      capsuleId: result.capsule.id,
      teamId: team.id,
      teamName: team.name,
      teamCode: team.code,
      leadName: team.leader.name,
      leadEmail: team.leader.email,
      seat: (highestSeat._max.seat ?? 0) + 1,
    },
  });
  return { status: "success", message: `${team.name} was added to ${result.pod.label}.` };
}

/** Remove a team from a pod while retaining the team and all other round seats. */
export async function removeTeamFromPod(prisma, capsuleKey, podId, teamId) {
  const result = await editablePod(prisma, capsuleKey, podId);
  if ("error" in result) return { status: "error", message: result.error };

  const membership = await prisma.podMembership.findUnique({ where: { podId_teamId: { podId, teamId } } });
  if (!membership) return { status: "error", message: "That team is not seated in this pod." };
  await prisma.podMembership.delete({ where: { id: membership.id } });
  return { status: "success", message: `${membership.teamName} was removed from ${result.pod.label}.` };
}

/** Delete a pending-round pod and its seats/lots; teams themselves remain intact. */
export async function deleteManualPod(prisma, capsuleKey, podId) {
  const result = await editablePod(prisma, capsuleKey, podId);
  if ("error" in result) return { status: "error", message: result.error };

  // Pod relations cascade: memberships, lots, bids and settlements belonging
  // only to this pod are removed, while the underlying teams stay onboarded.
  await prisma.pod.delete({ where: { id: result.pod.id } });
  return {
    status: "success",
    message: `${result.pod.label} was deleted. Its teams are still available to seat in another pod.`,
  };
}

/** The existing Remainder kind is the lucky/remainder flag; MAIN is unflagged. */
export async function setPodRemainderFlag(prisma, capsuleKey, podId, flagged) {
  if (typeof flagged !== "boolean") return { status: "error", message: "Choose a valid pod flag." };
  const result = await editablePod(prisma, capsuleKey, podId);
  if ("error" in result) return { status: "error", message: result.error };

  if (flagged) {
    const existingRemainder = await prisma.pod.findFirst({
      where: { capsuleId: result.capsule.id, kind: "REMAINDER", id: { not: podId } },
      select: { label: true },
    });
    if (existingRemainder) {
      return {
        status: "error",
        message: `${existingRemainder.label} is already this round's lucky / remainder pod. Unflag it before choosing another pod.`,
      };
    }
  }

  await prisma.pod.update({ where: { id: podId }, data: { kind: flagged ? "REMAINDER" : "MAIN" } });
  return {
    status: "success",
    message: `${result.pod.label} is ${flagged ? "flagged as a lucky / remainder pod" : "now a standard pod"}.`,
  };
}

/** Wipe every pod, lot, bid, settlement and frozen price snapshot for the event. */
export async function resetEvent(prisma) {
  const event = await ensureEvent(prisma);
  const capsuleIds = (
    await prisma.capsule.findMany({ where: { eventId: event.id }, select: { id: true } })
  ).map((capsule) => capsule.id);

  const removed = await prisma.pod.deleteMany({ where: { capsule: { eventId: event.id } } });
  if (capsuleIds.length > 0) {
    await prisma.roundTierPrice.deleteMany({ where: { capsuleId: { in: capsuleIds } } });
  }
  await prisma.capsule.updateMany({
    where: { eventId: event.id },
    data: { status: "PENDING", startedAt: null },
  });
  return { removed: removed.count };
}

/** Reset one capsule to its prepared, not-yet-started state while keeping its pods. */
export async function resetCapsule(prisma, capsuleKey) {
  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);

  if (!capsule) {
    return { status: "error", message: `Unknown capsule "${capsuleKey}".` };
  }

  const pods = await podIdsForCapsule(prisma, capsule.id);
  if (pods.length === 0) {
    return {
      status: "error",
      message: "That round has not been prepared yet. Start event first.",
    };
  }

  const lotRows = pods.flatMap((pod) =>
    capsule.subCapsules.map((subCapsule) => ({
      id: randomUUID(),
      podId: pod.id,
      subCapsuleId: subCapsule.id,
      tierRank: subCapsule.tierRank,
      status: "PENDING",
      openedAt: null,
      closesAt: null,
      frozenPrice: null,
      topBidId: null,
    })),
  );

  await prisma.$transaction(
    [
      prisma.roundTierPrice.deleteMany({ where: { capsuleId: capsule.id } }),
      prisma.lot.deleteMany({ where: { pod: { capsuleId: capsule.id } } }),
      prisma.lot.createMany({ data: lotRows }),
      prisma.capsule.update({
        where: { id: capsule.id },
        data: { status: "PENDING", startedAt: null },
      }),
    ],
    { timeout: 30_000 },
  );

  return {
    status: "success",
    capsuleId: capsule.id,
    message: `${capsule.name} is reset. Pod assignments are preserved; start the round when ready.`,
  };
}

/**
 * Rewind one live pod to its first auction item. Its memberships stay in
 * place; deleting its lots cascades only that pod's bids and settlements.
 */
export async function resetPod(prisma, capsuleKey, podId) {
  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);

  if (!capsule) {
    return { status: "error", message: `Unknown capsule "${capsuleKey}".` };
  }

  if (capsule.status !== "LIVE") {
    return { status: "error", message: "Only a live round can be reset pod by pod." };
  }

  const pod = await prisma.pod.findFirst({
    where: { id: podId, capsuleId: capsule.id },
    select: { id: true, label: true, kind: true },
  });

  if (!pod) {
    return { status: "error", message: "That pod does not belong to this round." };
  }

  // A remainder pod's prices are derived from every main pod. Once it has
  // begun, changing a main-pod result would make those already-visible prices
  // inconsistent, so a full round reset is the safe recovery path.
  if (pod.kind === "MAIN") {
    const remainderStarted = await prisma.lot.count({
      where: { pod: { capsuleId: capsule.id, kind: "REMAINDER" }, status: { not: "PENDING" } },
    });
    if (remainderStarted > 0) {
      return {
        status: "error",
        message: "This main pod cannot be reset after the lucky / remainder pod has started. Reset the round instead.",
      };
    }
  }

  const openingRank = pod.kind === "MAIN" ? firstBiddableRank(capsule.subCapsules) : null;
  const lotRows = capsule.subCapsules.map((subCapsule) => ({
    id: randomUUID(),
    podId: pod.id,
    subCapsuleId: subCapsule.id,
    tierRank: subCapsule.tierRank,
    status: openingRank === subCapsule.tierRank ? "OPEN" : "PENDING",
    openedAt: null,
    closesAt: null,
    frozenPrice: null,
    topBidId: null,
  }));

  await prisma.$transaction(
    [
      prisma.lot.deleteMany({ where: { podId: pod.id } }),
      prisma.lot.createMany({ data: lotRows }),
    ],
    { timeout: 30_000 },
  );

  // Remainder-pod tiers are intentionally opened together at prices frozen
  // from the untouched main-pod results.
  if (pod.kind === "REMAINDER") {
    await openRemainderPod(prisma, capsule.id);
  }

  return {
    status: "success",
    capsuleId: capsule.id,
    podId: pod.id,
    message: `${pod.label} is reset to its first item. Other pods and rounds are unchanged.`,
  };
}

/**
 * Rewind a capsule back to a selected tier. Earlier tiers stay settled; the
 * chosen tier and anything after it are recreated so bidding can resume there.
 */
export async function resetSubCapsule(prisma, capsuleKey, subCapsuleKey) {
  const event = await ensureEvent(prisma);
  const capsule = await ensureCapsule(prisma, event.id, capsuleKey);

  if (!capsule) {
    return { status: "error", message: `Unknown capsule "${capsuleKey}".` };
  }

  const target = capsule.subCapsules.find((subCapsule) => subCapsule.key === subCapsuleKey);
  if (!target) {
    return { status: "error", message: `Unknown tier "${subCapsuleKey}".` };
  }

  const pods = await podIdsForCapsule(prisma, capsule.id);
  if (pods.length === 0) {
    return {
      status: "error",
      message: "That round has not been prepared yet. Start event first.",
    };
  }

  const affected = capsule.subCapsules.filter((subCapsule) => subCapsule.tierRank >= target.tierRank);
  const affectedIds = affected.map((subCapsule) => subCapsule.id);
  const reopeningRank = capsule.status === "LIVE" ? firstBiddableRank(affected, target.tierRank) : null;

  const lotRows = pods.flatMap((pod) =>
    affected.map((subCapsule) => ({
      id: randomUUID(),
      podId: pod.id,
      subCapsuleId: subCapsule.id,
      tierRank: subCapsule.tierRank,
      status: pod.kind === "MAIN" && reopeningRank === subCapsule.tierRank ? "OPEN" : "PENDING",
      openedAt: null,
      closesAt: null,
      frozenPrice: null,
      topBidId: null,
    })),
  );

  await prisma.$transaction(
    [
      prisma.roundTierPrice.deleteMany({
        where: { capsuleId: capsule.id, subCapsuleId: { in: affectedIds } },
      }),
      prisma.lot.deleteMany({
        where: {
          pod: { capsuleId: capsule.id },
          subCapsuleId: { in: affectedIds },
        },
      }),
      prisma.lot.createMany({ data: lotRows }),
      prisma.capsule.update({
        where: { id: capsule.id },
        data: {
          status: capsule.status === "LIVE" ? "LIVE" : "PENDING",
          startedAt: capsule.status === "LIVE" ? capsule.startedAt ?? new Date() : null,
        },
      }),
    ],
    { timeout: 30_000 },
  );

  return {
    status: "success",
    capsuleId: capsule.id,
    message:
      capsule.status === "LIVE"
        ? `${target.name} is reset. Earlier tiers stay settled; this tier now resumes from a clean state.`
        : `${target.name} is reset. Earlier tiers stay settled; start the round to replay the remaining tiers.`,
  };
}

/**
 * The capsule currently open for bidding, if any. Only one can be live, but
 * should the database ever hold two, the one furthest along the running
 * order is the real one — it was opened last.
 */
export async function liveCapsule(prisma) {
  return prisma.capsule.findFirst({
    where: { event: { key: EVENT_KEY }, status: "LIVE" },
    orderBy: { sequenceOrder: "desc" },
    select: { id: true, key: true, name: true },
  });
}
