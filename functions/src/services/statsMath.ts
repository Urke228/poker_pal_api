import type { StatsChartPoint, StatsEntry, StatsOverview } from "../types/models";

/**
 * The single authoritative implementation of PokerPal's statistics.
 *
 * Both clients previously carried their own copy of this arithmetic
 * (`stats_screen.dart` and `statsMath.ts`). They agreed, and this reproduces
 * them exactly — including two behaviours that look like bugs but are the
 * established semantics:
 *
 *   1. A break-even finish is NOT counted as profitable (strictly greater).
 *   2. The "change" figures compare against every entry except the LAST ONE IN
 *      ARRAY ORDER, i.e. "what did the most recently added entry do to this
 *      number", not a date-based or time-windowed comparison.
 *
 * Pure by design: no Firestore imports, so it is testable on its own.
 */

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

export const entryCost = (e: StatsEntry): number => num(e.buyin) + num(e.rebuy);

interface Totals {
  played: number;
  totalBuyin: number;
  totalRebuy: number;
  totalCost: number;
  totalWin: number;
  profitLoss: number;
  winRate: number;
  roi: number;
}

export function computeTotals(entries: StatsEntry[]): Totals {
  let totalBuyin = 0;
  let totalRebuy = 0;
  let totalWin = 0;
  let profitable = 0;

  for (const e of entries) {
    totalBuyin += num(e.buyin);
    totalRebuy += num(e.rebuy);
    totalWin += num(e.win);
    if (num(e.win) > entryCost(e)) profitable++;
  }

  const totalCost = totalBuyin + totalRebuy;
  const profitLoss = totalWin - totalCost;
  const played = entries.length;

  return {
    played,
    totalBuyin,
    totalRebuy,
    totalCost,
    totalWin,
    profitLoss,
    winRate: played > 0 ? (profitable / played) * 100 : 0,
    roi: totalCost > 0 ? (profitLoss / totalCost) * 100 : 0,
  };
}

export function computeOverview(entries: StatsEntry[]): StatsOverview {
  const cur = computeTotals(entries);
  const prevList = entries.length > 1 ? entries.slice(0, -1) : [];
  const hasPrev = prevList.length > 0;
  const prev = computeTotals(prevList);

  return {
    ...cur,
    winRateChange: hasPrev ? cur.winRate - prev.winRate : null,
    earningsChange: hasPrev ? cur.totalWin - prev.totalWin : null,
    roiChange: hasPrev ? cur.roi - prev.roi : null,
  };
}

/** Running cumulative profit, oldest first. */
export function buildChart(entries: StatsEntry[]): StatsChartPoint[] {
  const sorted = [...entries].sort(
    (a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0),
  );
  let cumulative = 0;
  return sorted.map((e) => {
    cumulative += num(e.win) - entryCost(e);
    return {
      dateMs: Date.parse(e.date) || Date.now(),
      cumulative,
      label: e.title,
    };
  });
}
