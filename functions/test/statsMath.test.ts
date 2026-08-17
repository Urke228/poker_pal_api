import { describe, expect, it } from "vitest";
import { buildChart, computeOverview, computeTotals } from "../src/services/statsMath";
import type { StatsEntry } from "../src/types/models";

const entry = (over: Partial<StatsEntry> = {}): StatsEntry => ({
  id: "e1",
  date: "2026-01-01",
  title: "Friday game",
  buyin: 20,
  rebuy: 0,
  win: 0,
  ...over,
});

describe("computeTotals", () => {
  it("sums cost as buy-in plus rebuy and profit as winnings minus cost", () => {
    const totals = computeTotals([
      entry({ buyin: 20, rebuy: 10, win: 60 }),
      entry({ buyin: 20, rebuy: 0, win: 0 }),
    ]);
    expect(totals.totalBuyin).toBe(40);
    expect(totals.totalRebuy).toBe(10);
    expect(totals.totalCost).toBe(50);
    expect(totals.totalWin).toBe(60);
    expect(totals.profitLoss).toBe(10);
    expect(totals.played).toBe(2);
  });

  it("does not count a break-even finish as profitable", () => {
    // win == cost exactly; the historical rule is strictly greater.
    const totals = computeTotals([entry({ buyin: 20, rebuy: 5, win: 25 })]);
    expect(totals.winRate).toBe(0);
  });

  it("counts a finish above cost as profitable", () => {
    const totals = computeTotals([entry({ buyin: 20, rebuy: 5, win: 25.01 })]);
    expect(totals.winRate).toBe(100);
  });

  it("returns zeroed rates rather than dividing by zero", () => {
    const totals = computeTotals([]);
    expect(totals.winRate).toBe(0);
    expect(totals.roi).toBe(0);
    expect(totals.profitLoss).toBe(0);
  });

  it("computes ROI against total cost", () => {
    const totals = computeTotals([entry({ buyin: 100, rebuy: 0, win: 150 })]);
    expect(totals.roi).toBeCloseTo(50);
  });

  it("treats missing numbers as zero instead of producing NaN", () => {
    const totals = computeTotals([
      { id: "x", date: "2026-01-01", title: "legacy" } as unknown as StatsEntry,
    ]);
    expect(totals.totalCost).toBe(0);
    expect(Number.isNaN(totals.profitLoss)).toBe(false);
  });
});

describe("computeOverview deltas", () => {
  it("has no deltas for a single entry", () => {
    const o = computeOverview([entry({ win: 100 })]);
    expect(o.winRateChange).toBeNull();
    expect(o.earningsChange).toBeNull();
    expect(o.roiChange).toBeNull();
  });

  it("compares against every entry except the last in array order", () => {
    // Deliberately out of date order: the delta must follow array position,
    // matching what both clients have always shown.
    const o = computeOverview([
      entry({ date: "2026-05-01", win: 0 }),
      entry({ date: "2026-01-01", win: 100 }),
    ]);
    // Previous slice is just the first entry: 0 won, 0% win rate.
    expect(o.earningsChange).toBe(100);
    expect(o.winRateChange).toBe(50);
  });
});

describe("buildChart", () => {
  it("accumulates profit in date order regardless of input order", () => {
    const points = buildChart([
      entry({ date: "2026-03-01", buyin: 20, win: 0, title: "March" }),
      entry({ date: "2026-01-01", buyin: 20, win: 50, title: "January" }),
    ]);
    expect(points.map((p) => p.label)).toEqual(["January", "March"]);
    expect(points[0].cumulative).toBe(30);
    expect(points[1].cumulative).toBe(10);
  });

  it("returns an empty series for no entries", () => {
    expect(buildChart([])).toEqual([]);
  });
});
