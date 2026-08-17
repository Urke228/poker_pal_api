import { describe, expect, it } from "vitest";
import { assertOrganizer, payoutFractions } from "../src/services/tournaments";
import { ApiError } from "../src/lib/errors";
import {
  createTournamentSchema,
  ensureProfileSchema,
  updatePlayerSchema,
} from "../src/validation/schemas";
import type { Tournament } from "../src/types/models";

const tournament = (over: Partial<Tournament> = {}): Tournament =>
  ({ id: "t1", createdBy: "organizer", ...over }) as Tournament;

const validBody = {
  name: "Friday game",
  dateTime: "2026-09-01T19:00:00.000Z",
  buyIn: 20,
  playerLimit: 8,
  payoutStructure: "standard",
  isPublic: true,
  description: "",
  rules: "",
  allowRebuys: true,
  allowAddons: false,
  lateRegistration: false,
};

describe("assertOrganizer", () => {
  it("allows the organizer", () => {
    expect(() => assertOrganizer(tournament(), "organizer")).not.toThrow();
  });

  it("rejects anyone else with a 403", () => {
    try {
      assertOrganizer(tournament(), "someone-else");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).code).toBe("FORBIDDEN");
    }
  });
});

describe("payoutFractions", () => {
  it("splits the named structures the way the clients always have", () => {
    expect(payoutFractions("standard")).toEqual([0.5, 0.3, 0.2]);
    expect(payoutFractions("top-heavy")).toEqual([0.7, 0.2, 0.1]);
    expect(payoutFractions("flat")).toEqual([0.4, 0.3, 0.2, 0.1]);
    expect(payoutFractions("winner-takes-all")).toEqual([1]);
  });

  it("converts manual percentages to fractions", () => {
    expect(payoutFractions("manual", [60, 40])).toEqual([0.6, 0.4]);
  });

  it("falls back to winner-takes-all when manual percentages are empty", () => {
    expect(payoutFractions("manual", [])).toEqual([1]);
  });

  it("sums to one for every named structure", () => {
    for (const s of ["standard", "top-heavy", "flat", "winner-takes-all"] as const) {
      const total = payoutFractions(s).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1);
    }
  });
});

describe("createTournamentSchema", () => {
  it("accepts a well-formed tournament", () => {
    const parsed = createTournamentSchema.parse(validBody);
    expect(parsed.name).toBe("Friday game");
    // Defaults fill in the fields the web form does not send.
    expect(parsed.organizerIsPlaying).toBe(false);
    expect(parsed.groupMemberUids).toEqual([]);
  });

  it("rejects an empty name", () => {
    expect(() => createTournamentSchema.parse({ ...validBody, name: "  " })).toThrow();
  });

  it("rejects a negative buy-in", () => {
    expect(() => createTournamentSchema.parse({ ...validBody, buyIn: -1 })).toThrow();
  });

  it("accepts a free tournament", () => {
    expect(() => createTournamentSchema.parse({ ...validBody, buyIn: 0 })).not.toThrow();
  });

  it("rejects a player limit below two or above one hundred", () => {
    expect(() => createTournamentSchema.parse({ ...validBody, playerLimit: 1 })).toThrow();
    expect(() => createTournamentSchema.parse({ ...validBody, playerLimit: 101 })).toThrow();
  });

  it("rejects an unknown payout structure", () => {
    expect(() =>
      createTournamentSchema.parse({ ...validBody, payoutStructure: "pyramid" }),
    ).toThrow();
  });

  it("rejects an unparseable date", () => {
    expect(() =>
      createTournamentSchema.parse({ ...validBody, dateTime: "next tuesday" }),
    ).toThrow();
  });

  it("requires percentages when the structure is manual", () => {
    expect(() =>
      createTournamentSchema.parse({ ...validBody, payoutStructure: "manual" }),
    ).toThrow();
    expect(() =>
      createTournamentSchema.parse({
        ...validBody,
        payoutStructure: "manual",
        manualPayouts: [70, 30],
      }),
    ).not.toThrow();
  });

  it("rejects a payout percentage above one hundred", () => {
    expect(() =>
      createTournamentSchema.parse({
        ...validBody,
        payoutStructure: "manual",
        manualPayouts: [120],
      }),
    ).toThrow();
  });
});

describe("updatePlayerSchema", () => {
  it("accepts realistic counts", () => {
    expect(() =>
      updatePlayerSchema.parse({ buyInPaid: true, rebuys: 2, addOns: 1 }),
    ).not.toThrow();
  });

  it("accepts an empty patch", () => {
    expect(() => updatePlayerSchema.parse({})).not.toThrow();
  });

  it("rejects negative counts", () => {
    expect(() => updatePlayerSchema.parse({ rebuys: -1 })).toThrow();
    expect(() => updatePlayerSchema.parse({ addOns: -1 })).toThrow();
  });

  it("rejects fractional counts", () => {
    expect(() => updatePlayerSchema.parse({ rebuys: 1.5 })).toThrow();
  });

  it("rejects counts large enough to distort the prize pool", () => {
    // These multiply into the pool that finalization checks winnings against,
    // so an implausible count would make that ceiling meaningless.
    expect(() => updatePlayerSchema.parse({ rebuys: 1e15 })).toThrow();
    expect(() => updatePlayerSchema.parse({ addOns: 101 })).toThrow();
  });
});

describe("ensureProfileSchema", () => {
  it("accepts an absent username, since the API falls back to the email", () => {
    expect(() => ensureProfileSchema.parse({})).not.toThrow();
  });

  it("accepts a normal username and trims it", () => {
    expect(ensureProfileSchema.parse({ username: "  Ada  " }).username).toBe("Ada");
  });

  it("rejects a whitespace-only username", () => {
    expect(() => ensureProfileSchema.parse({ username: "   " })).toThrow();
  });

  it("rejects an absurdly long username", () => {
    expect(() => ensureProfileSchema.parse({ username: "x".repeat(5000) })).toThrow();
  });
});
