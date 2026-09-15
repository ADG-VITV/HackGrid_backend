/**
 * Auction rules, in plain JS. Everything here is pure — no DB, no I/O. The
 * frontend repository carries a copy (frontend/lib/auction-rules.mjs) for the
 * constants it shows in the UI — keep the two in sync when timings change.
 *
 * Timing matches the existing client architecture:
 *   - each tier gets a 7 minute window once it opens
 *   - after a bid lands, the tier closes 13s later unless someone raises
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

/** How long a tier stays open once nobody is bidding on it. */
export const SUBCAPSULE_SECONDS = seconds("HACKGRID_TIER_SECONDS", 7 * 60);
/** Anti-snipe window: a tier closes this long after the last accepted bid. */
export const BID_TIMEOUT_SECONDS = seconds("HACKGRID_BID_TIMEOUT_SECONDS", 13);
/** Every team's coin budget for the whole event, across all four capsules. */
export const STARTING_BALANCE = 10000;

/** How long remainder-pod teams get to claim a tier at the frozen price. */
export const REMAINDER_PICK_SECONDS = seconds("HACKGRID_REMAINDER_SECONDS", 90);

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
 * The 10s anti-snipe window can never push past the 7 minute tier window.
 */
export function computeClosesAt({ openedAt, lastBidAt }) {
  const hardStop = new Date(openedAt).getTime() + SUBCAPSULE_SECONDS * 1000;
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
