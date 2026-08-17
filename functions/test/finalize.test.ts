import { describe, expect, it } from "vitest";
import { validatePlacements, validateWinnings } from "../src/services/finalize";
import { assertKnownPlayer, prizePool } from "../src/services/participants";
import { ApiError } from "../src/lib/errors";
import type { PlayerSummary, Tournament } from "../src/types/models";

const player = (over: Partial<PlayerSummary> = {}): PlayerSummary => ({
  id: "u1",
  uid: "u1",
  name: "Ada",
  isGuest: false,
  buyInPaid: true,
  rebuys: 0,
  addOns: 0,
  ...over,
});

const tournament = (over: Partial<Tournament> = {}): Tournament =>
  ({
    id: "t1",
    name: "Friday game",
    buyIn: 20,
    playerLimit: 8,
    participants: ["u1", "u2"],
    createdBy: "organizer",
    status: "open",
    ...over,
  }) as Tournament;

/** Pulls the stable error code out so tests assert on contract, not wording. */
function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
  throw new Error("expected the call to throw");
}

describe("validatePlacements", () => {
  it("accepts a contiguous ranking starting at 1", () => {
    expect(() =>
      validatePlacements([
        { uid: "u1", place: 1, winnings: 0 },
        { uid: "u2", place: 2, winnings: 0 },
        { uid: "u3", place: 3, winnings: 0 },
      ]),
    ).not.toThrow();
  });

  it("accepts results supplied out of order", () => {
    expect(() =>
      validatePlacements([
        { uid: "u2", place: 2, winnings: 0 },
        { uid: "u1", place: 1, winnings: 0 },
      ]),
    ).not.toThrow();
  });

  it("rejects two players sharing a place", () => {
    expect(
      codeOf(() =>
        validatePlacements([
          { uid: "u1", place: 1, winnings: 0 },
          { uid: "u2", place: 1, winnings: 0 },
        ]),
      ),
    ).toBe("INVALID_PLACEMENTS");
  });

  it("rejects a gap in the ranking", () => {
    expect(
      codeOf(() =>
        validatePlacements([
          { uid: "u1", place: 1, winnings: 0 },
          { uid: "u2", place: 3, winnings: 0 },
        ]),
      ),
    ).toBe("INVALID_PLACEMENTS");
  });

  it("rejects a ranking that does not start at 1", () => {
    expect(
      codeOf(() => validatePlacements([{ uid: "u1", place: 2, winnings: 0 }])),
    ).toBe("INVALID_PLACEMENTS");
  });
});

describe("prizePool", () => {
  it("counts only players who paid, plus rebuys and add-ons", () => {
    const t = tournament({ buyIn: 20 });
    const pool = prizePool(t, [
      player({ uid: "u1", buyInPaid: true, rebuys: 1 }),
      player({ uid: "u2", buyInPaid: true, addOns: 1 }),
      player({ uid: "u3", buyInPaid: false }),
    ]);
    // 2 paid entries + 1 rebuy + 1 add-on = 4 buy-ins.
    expect(pool).toBe(80);
  });
});

describe("validateWinnings", () => {
  it("allows paying out exactly the pool", () => {
    expect(() =>
      validateWinnings([{ uid: "u1", place: 1, winnings: 80 }], 80),
    ).not.toThrow();
  });

  it("rejects paying out more than was collected", () => {
    expect(
      codeOf(() => validateWinnings([{ uid: "u1", place: 1, winnings: 80.5 }], 80)),
    ).toBe("INVALID_WINNINGS");
  });

  it("tolerates a rounding cent from split percentages", () => {
    expect(() =>
      validateWinnings(
        [
          { uid: "u1", place: 1, winnings: 33.34 },
          { uid: "u2", place: 2, winnings: 33.33 },
          { uid: "u3", place: 3, winnings: 33.33 },
        ],
        100,
      ),
    ).not.toThrow();
  });
});

describe("assertKnownPlayer", () => {
  const players = [player({ uid: "u1" }), player({ id: "guest:steve", uid: null, name: "Steve", isGuest: true })];

  it("accepts a participant and a known guest", () => {
    expect(() => assertKnownPlayer(players, "u1")).not.toThrow();
    expect(() => assertKnownPlayer(players, undefined, "steve")).not.toThrow();
  });

  it("rejects someone who is not in the tournament", () => {
    expect(codeOf(() => assertKnownPlayer(players, "stranger"))).toBe("UNKNOWN_PLAYER");
    expect(codeOf(() => assertKnownPlayer(players, undefined, "Nobody"))).toBe("UNKNOWN_PLAYER");
  });
});
