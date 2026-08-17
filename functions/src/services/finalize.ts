import {
  db,
  FieldValue,
  TOURNAMENTS,
  USERS,
  toStatsDate,
} from "../lib/firestore";
import { badRequest, conflict } from "../lib/errors";
import type { PlayerSummary, Tournament, TournamentResult } from "../types/models";
import { assertKnownPlayer, prizePool } from "./participants";

export interface FinalizeResultInput {
  uid?: string;
  guestName?: string;
  place: number;
  winnings: number;
}

/**
 * Places must be a clean 1..N ranking: no duplicates, no gaps, starting at 1.
 * Pure so the rule can be tested without Firestore.
 */
export function validatePlacements(results: FinalizeResultInput[]): void {
  const places = results.map((r) => r.place).sort((a, b) => a - b);
  const seen = new Set<number>();
  for (const p of places) {
    if (seen.has(p)) {
      throw badRequest("INVALID_PLACEMENTS", `Two players are both in place ${p}.`);
    }
    seen.add(p);
  }
  for (let i = 0; i < places.length; i++) {
    if (places[i] !== i + 1) {
      throw badRequest(
        "INVALID_PLACEMENTS",
        `Places must run from 1 to ${places.length} with no gaps.`,
      );
    }
  }
}

/** Guards against paying out more than was ever collected. */
export function validateWinnings(results: FinalizeResultInput[], pool: number): void {
  const total = results.reduce((sum, r) => sum + r.winnings, 0);
  // A cent of tolerance so floating-point splits of an exact pool still pass.
  if (total > pool + 0.01) {
    throw badRequest(
      "INVALID_WINNINGS",
      `Total winnings (${total.toFixed(2)}) exceed the prize pool (${pool.toFixed(2)}).`,
    );
  }
}

/**
 * Finalizes a tournament: records the standings, closes it, and writes a stats
 * entry into every registered finisher's profile.
 *
 * This has to live on the server. Firestore rules only ever let a client write
 * its OWN `users/{uid}` document, so no client can post results into the other
 * participants' histories — the rules would reject it, and rightly so. With the
 * Admin SDK we can do it, and do it atomically: either every participant's
 * stats update and the tournament closes, or nothing changes at all.
 */
export async function finalizeTournament(
  t: Tournament,
  players: PlayerSummary[],
  results: FinalizeResultInput[],
): Promise<TournamentResult[]> {
  if (t.status === "finished") {
    throw conflict("ALREADY_FINALIZED", "That tournament has already been finalized.");
  }

  validatePlacements(results);
  for (const r of results) assertKnownPlayer(players, r.uid, r.guestName);
  validateWinnings(results, prizePool(t, players));

  const byUid = new Map(players.filter((p) => p.uid).map((p) => [p.uid as string, p]));
  const byGuestName = new Map(
    players.filter((p) => p.isGuest).map((p) => [p.name.toLowerCase(), p]),
  );

  const stored: TournamentResult[] = results
    .map((r) => {
      const player = r.uid
        ? byUid.get(r.uid)
        : byGuestName.get((r.guestName ?? "").toLowerCase());
      return {
        uid: r.uid ?? null,
        name: player?.name ?? r.guestName ?? "Player",
        place: r.place,
        winnings: r.winnings,
      };
    })
    .sort((a, b) => a.place - b.place);

  const date = toStatsDate(new Date());
  const tournamentRef = db().collection(TOURNAMENTS).doc(t.id);

  await db().runTransaction(async (tx) => {
    // Firestore requires every read in a transaction to precede every write.
    const registered = stored.filter((r) => r.uid);
    const userRefs = registered.map((r) => db().collection(USERS).doc(r.uid as string));
    const userSnaps = userRefs.length > 0 ? await tx.getAll(...userRefs) : [];

    const fresh = await tx.get(tournamentRef);
    if (fresh.data()?.status === "finished") {
      throw conflict("ALREADY_FINALIZED", "That tournament has already been finalized.");
    }

    tx.update(tournamentRef, {
      status: "finished",
      results: stored,
      finalizedAt: FieldValue.serverTimestamp(),
    });

    userSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const result = registered[i];
      const player = byUid.get(result.uid as string);
      const current = Array.isArray(snap.data()?.tournaments) ? snap.data()!.tournaments : [];
      // Rebuys and add-ons are tracked as counts on the roster; the stats entry
      // wants the money they cost.
      const rebuyCost = ((player?.rebuys ?? 0) + (player?.addOns ?? 0)) * t.buyIn;
      current.push({
        id: `${t.id}:${result.uid}`,
        date,
        title: t.name,
        buyin: t.buyIn,
        rebuy: rebuyCost,
        win: result.winnings,
      });
      tx.update(snap.ref, { tournaments: current });
    });
  });

  return stored;
}
