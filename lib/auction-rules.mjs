/**
 * Auction rules, in plain JS. Everything here is pure — no DB, no I/O. The
 * frontend repository carries a copy (frontend/lib/auction-rules.mjs) for the
 * constants it shows in the UI — keep the two in sync when timings change.
 *
 * Timing:
 *   - in a main pod each tier gets a 5 minute window once it opens
 *   - in a remainder (lucky) pod each tier gets a 3 minute window
 *   - after a bid lands, the tier closes 13s later unless someone raises;
 *     the window is a hard stop, so bidding never runs past it
 */

/**
 * Timings are overridable from the environment so a dry run can play a whole
 * event in a couple of minutes without touching the code. The guard keeps this
 * safe in the browser bundle, where `process` may not exist.
 */
function seconds(name, fallback) {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long a main-pod tier stays open once nobody is bidding on it. */
export const SUBCAPSULE_SECONDS = seconds("HACKGRID_TIER_SECONDS", 5 * 60);
/** Anti-snipe window: a tier closes this long after the last accepted bid. */
export const BID_TIMEOUT_SECONDS = seconds("HACKGRID_BID_TIMEOUT_SECONDS", 13);
/** Every team's coin budget for the whole event, across all four capsules. */
export const STARTING_BALANCE = 10000;

/**
 * How long a remainder-pod tier stays open once nobody is bidding on it.
 * Shorter than a main pod's: the price is already fixed, a bid only decides
 * who takes the tier, and a tier nobody wants is skipped (see canSkipUnbidLot).
 */
export const REMAINDER_TIER_SECONDS = seconds("HACKGRID_REMAINDER_SECONDS", 3 * 60);

/** The window a tier in a pod of this kind runs for. */
export function tierWindowSeconds(podKind) {
  return podKind === "REMAINDER" ? REMAINDER_TIER_SECONDS : SUBCAPSULE_SECONDS;
}

/**
 * A remainder pod is smaller than the tier list, so its teams may let tiers
 * go by. They may only do so while every team still without a tier can be
 * guaranteed one later: with `lotsLeftAfter` tiers still to come and
 * `unassignedTeams` teams still empty-handed, an unbid tier is skipped only
 * if lotsLeftAfter >= unassignedTeams. Otherwise it is handed out at random,
 * exactly as a main pod does, so nobody leaves the round with nothing.
 */
export function canSkipUnbidLot({ lotsLeftAfter, unassignedTeams }) {
  return unassignedTeams <= 0 || lotsLeftAfter >= unassignedTeams;
}

/**
 * A remainder pod of exactly one team has nobody to bid against, so it does
 * not bid at all: every tier is shown at its frozen price and the team picks
 * one. No clock runs in this mode.
 */
export function isPickMode({ podKind, podSize }) {
  return podKind === "REMAINDER" && podSize === 1;
}

/**
 * How many of a pod's teams must be connected before its clock starts.
 *
 * A tier should not tick away while people are still arriving, so the timer
 * holds until every seat in the pod is filled — a round never starts with a
 * team missing.
 */
export function quorumFor(podSize) {
  return Math.max(1, podSize);
}

export const BID_REJECTED = {
  LOT_NOT_OPEN: "This tier is not open for bidding.",
  LOT_EXPIRED: "Time is up for this tier.",
  AUTO_ASSIGNED: "This tier is auto-assigned to the last team standing — it is never bid on.",
  NOT_IN_POD: "Your team is not seated in this pod.",
  ALREADY_WON: "Your team already won a tier in this capsule.",
  ALREADY_TOP: "You already hold the top bid.",
  ALREADY_CLAIMED: "You already hold a claim on another tier in this pod. Drop it or wait to be outbid.",
  AWAITING_QUORUM: "Bidding has not opened yet — waiting for the rest of the pod to arrive.",
  BELOW_MINIMUM: "Bid is below the minimum next bid.",
  OVER_BUDGET: "Bid exceeds your remaining coin balance.",
  RESERVE_LOCKED: "Bid would eat into the coins reserved for the capsules still to come.",
  NOT_INTEGER: "Bid must be a whole number of coins.",
  PICK_MODE: "Your lucky pod has no one to bid against — pick a tier instead.",
};

/** Why a remainder pod of one could not take the tier it picked. */
export const CLAIM_REJECTED = {
  LOT_NOT_OPEN: BID_REJECTED.LOT_NOT_OPEN,
  NOT_IN_POD: BID_REJECTED.NOT_IN_POD,
  ALREADY_WON: BID_REJECTED.ALREADY_WON,
  OVER_BUDGET: "That tier costs more than your remaining coin balance.",
  RESERVE_LOCKED: "That tier would eat into the coins reserved for the capsules still to come.",
  NOT_PICK_MODE: "This pod bids for its tiers; picking is only for a lucky pod of one team.",
};

/**
 * The most a team may bid in a capsule: whatever it has left, minus the coins
 * it must keep for the capsules after this one (see reserveAfter). Never
 * negative, so a team that is already at its reserve simply cannot bid.
 */
export function spendingCapFor({ remainingBalance, reserve }) {
  return Math.max(0, remainingBalance - (reserve ?? 0));
}

/**
 * The smallest bid the server will accept on a lot right now.
 * With no bids yet that is the listed starting bid; after that it is the
 * standing top plus the tier's minimum increment (rulebook 6.2).
 */
export function nextMinBid({ startingBid, minIncrement, topAmount }) {
  if (topAmount === null || topAmount === undefined) {
    return startingBid;
  }
  return topAmount + (minIncrement ?? 0);
}

/**
 * Deadline for a lot given when it opened and when the last bid landed.
 * The anti-snipe window can never push past the tier window, which is the
 * main-pod window unless the caller passes the pod's own.
 */
export function computeClosesAt({ openedAt, lastBidAt, windowSeconds = SUBCAPSULE_SECONDS }) {
  const hardStop = new Date(openedAt).getTime() + windowSeconds * 1000;
  if (!lastBidAt) {
    return new Date(hardStop);
  }
  const softStop = new Date(lastBidAt).getTime() + BID_TIMEOUT_SECONDS * 1000;
  return new Date(Math.min(softStop, hardStop));
}

/**
 * The single validation gate. Called on the server for every incoming bid;
 * the client calls it too, but only to grey out a button — the server's
 * answer is the one that counts.
 *
 * @returns {{ ok: true, amount: number } | { ok: false, code: string, reason: string, nextMin?: number }}
 */
export function validateBid({
  amount,
  now,
  lotStatus,
  closesAt,
  isAutoAssigned,
  startingBid,
  minIncrement,
  topAmount,
  topTeamId,
  teamId,
  isSeatedInPod,
  hasWonInCapsule,
  remainingBalance,
  reserve = 0,
  holdsAnotherClaim = false,
  timerStarted = true,
  pickMode = false,
}) {
  const fail = (code, extra = {}) => ({ ok: false, code, reason: BID_REJECTED[code], ...extra });

  if (!Number.isInteger(amount) || amount <= 0) {
    return fail("NOT_INTEGER");
  }
  if (!isSeatedInPod) {
    return fail("NOT_IN_POD");
  }
  if (isAutoAssigned) {
    return fail("AUTO_ASSIGNED");
  }
  // A lucky pod of one never bids; it picks (validateClaim).
  if (pickMode) {
    return fail("PICK_MODE");
  }
  if (lotStatus !== "OPEN") {
    return fail("LOT_NOT_OPEN");
  }
  // The tier is open but its clock has not started, so it is not yet biddable.
  if (!timerStarted) {
    return fail("AWAITING_QUORUM");
  }
  if (closesAt && new Date(now).getTime() > new Date(closesAt).getTime()) {
    return fail("LOT_EXPIRED");
  }
  if (hasWonInCapsule) {
    return fail("ALREADY_WON");
  }
  if (topTeamId && topTeamId === teamId) {
    return fail("ALREADY_TOP");
  }
  // Remainder pod only: a team may sit on one tier at a time, so it cannot
  // block several at once while it decides (rulebook 7).
  if (holdsAnotherClaim) {
    return fail("ALREADY_CLAIMED");
  }

  const minimum = nextMinBid({ startingBid, minIncrement, topAmount });
  if (amount < minimum) {
    return fail("BELOW_MINIMUM", { nextMin: minimum });
  }
  if (amount > remainingBalance) {
    return fail("OVER_BUDGET", { nextMin: minimum });
  }
  const spendingCap = spendingCapFor({ remainingBalance, reserve });
  if (amount > spendingCap) {
    return fail("RESERVE_LOCKED", { nextMin: minimum, spendingCap, reserve });
  }

  return { ok: true, amount };
}

/**
 * The validation gate for a pick (a remainder pod of one taking a tier at
 * its frozen price). Same shape as validateBid so the acknowledgement can be
 * rendered by the same code.
 *
 * @returns {{ ok: true, price: number } | { ok: false, code: string, reason: string }}
 */
export function validateClaim({
  lotStatus,
  price,
  isSeatedInPod,
  hasWonInCapsule,
  remainingBalance,
  reserve = 0,
  pickMode,
}) {
  const fail = (code, extra = {}) => ({ ok: false, code, reason: CLAIM_REJECTED[code], ...extra });

  if (!isSeatedInPod) {
    return fail("NOT_IN_POD");
  }
  if (!pickMode) {
    return fail("NOT_PICK_MODE");
  }
  if (lotStatus !== "OPEN") {
    return fail("LOT_NOT_OPEN");
  }
  if (hasWonInCapsule) {
    return fail("ALREADY_WON");
  }
  if (price > remainingBalance) {
    return fail("OVER_BUDGET");
  }
  const spendingCap = spendingCapFor({ remainingBalance, reserve });
  if (price > spendingCap) {
    return fail("RESERVE_LOCKED", { spendingCap, reserve });
  }

  return { ok: true, price };
}
