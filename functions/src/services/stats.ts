import { db, FieldValue, STATS, USERS, asNumber } from "../lib/firestore";
import { notFound } from "../lib/errors";
import type { StatsEntry, StatsResponse } from "../types/models";
import { buildChart, computeOverview } from "./statsMath";

/**
 * Stats entries live in an owner-only `stats/{uid}` document, as a `tournaments`
 * array field. They used to be a field on `users/{uid}` itself, but that doc is
 * readable by every signed-in user (it's the public profile), which exposed
 * every player's buy-in and rebuy amounts. Moving the history into its own
 * document lets the rules deny everyone but the owner.
 *
 * Legacy: docs written before the move still carry `users/{uid}.tournaments`.
 * Reads fall back to it, and every write migrates — it stores the rows in
 * `stats/{uid}` and deletes the legacy field — so the old location drains as
 * users are touched. `scripts/migrate-history.ts` backfills the rest.
 *
 * Field names inside a row are historical and deliberately preserved: `buyin`
 * (lowercase "i"), `rebuy` (singular, a money amount rather than a count),
 * `title`, and `date` as a plain `yyyy-MM-dd` string.
 */
function mapEntry(raw: unknown, index: number): StatsEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const entry: StatsEntry = {
    // Legacy rows predate the id field; fall back to a positional id so they
    // can still be addressed for deletion.
    id: typeof e.id === "string" && e.id ? e.id : `legacy:${index}`,
    date: typeof e.date === "string" ? e.date : "",
    title: typeof e.title === "string" ? e.title : "",
    buyin: asNumber(e.buyin),
    rebuy: asNumber(e.rebuy),
    win: asNumber(e.win),
  };
  // Present only on finalized results, and absent on every entry written
  // before these fields existed — so they stay optional rather than defaulted.
  if (typeof e.tournamentId === "string" && e.tournamentId) {
    entry.tournamentId = e.tournamentId;
  }
  if (typeof e.place === "number") entry.place = e.place;
  return entry;
}

/** The minimal snapshot surface this module needs — matches real and test dbs. */
interface SnapshotLike {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

/**
 * Picks the history rows out of the (stats doc, user doc) snapshot pair.
 * `hadLegacy` reports whether the user doc still carries the old field, so the
 * caller's next write can clear it.
 */
export function pickHistory(
  statsSnap: SnapshotLike,
  userSnap: SnapshotLike,
): { rows: unknown[]; hadLegacy: boolean } {
  const hadLegacy = Array.isArray(userSnap.data()?.tournaments);
  const fromStats = statsSnap.exists ? statsSnap.data()?.tournaments : undefined;
  if (Array.isArray(fromStats)) return { rows: fromStats, hadLegacy };
  return { rows: hadLegacy ? (userSnap.data()!.tournaments as unknown[]) : [], hadLegacy };
}

/**
 * Writes the rows to `stats/{uid}` and, when the user doc still carries the
 * legacy field, deletes it — every write is also a migration.
 */
export function writeHistory(
  tx: FirebaseFirestore.Transaction,
  uid: string,
  rows: unknown[],
  hadLegacy: boolean,
): void {
  tx.set(db().collection(STATS).doc(uid), { tournaments: rows }, { merge: true });
  if (hadLegacy) {
    tx.update(db().collection(USERS).doc(uid), { tournaments: FieldValue.delete() });
  }
}

export async function readEntries(uid: string): Promise<StatsEntry[]> {
  const [statsSnap, userSnap] = await Promise.all([
    db().collection(STATS).doc(uid).get(),
    db().collection(USERS).doc(uid).get(),
  ]);
  if (!userSnap.exists) throw notFound("That user");
  const { rows } = pickHistory(statsSnap, userSnap);
  return rows.map(mapEntry);
}

export async function getStats(uid: string): Promise<StatsResponse> {
  const entries = await readEntries(uid);
  return {
    overview: computeOverview(entries),
    entries,
    chart: buildChart(entries),
  };
}

export interface StatsEntryInput {
  date: string;
  title: string;
  buyin: number;
  rebuy: number;
  win: number;
}

/**
 * Appended inside a transaction. Both clients previously did a read followed
 * by a whole-array overwrite, which loses a concurrent write; this does not.
 */
export async function addEntry(uid: string, input: StatsEntryInput): Promise<StatsEntry> {
  const statsRef = db().collection(STATS).doc(uid);
  const userRef = db().collection(USERS).doc(uid);
  const entry = {
    id: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    date: input.date,
    title: input.title.trim(),
    buyin: input.buyin,
    rebuy: input.rebuy,
    win: input.win,
  };

  await db().runTransaction(async (tx) => {
    const [statsSnap, userSnap] = await tx.getAll(statsRef, userRef);
    if (!userSnap.exists) throw notFound("That user");
    const { rows, hadLegacy } = pickHistory(statsSnap, userSnap);
    writeHistory(tx, uid, [...rows, entry], hadLegacy);
  });

  return entry;
}

export async function deleteEntry(uid: string, entryId: string): Promise<void> {
  const statsRef = db().collection(STATS).doc(uid);
  const userRef = db().collection(USERS).doc(uid);
  await db().runTransaction(async (tx) => {
    const [statsSnap, userSnap] = await tx.getAll(statsRef, userRef);
    if (!userSnap.exists) throw notFound("That user");
    const { rows: current, hadLegacy } = pickHistory(statsSnap, userSnap);

    let next: unknown[];
    if (entryId.startsWith("legacy:")) {
      const index = Number(entryId.slice("legacy:".length));
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        throw notFound("That stats entry");
      }
      next = current.filter((_, i) => i !== index);
    } else {
      next = current.filter((e) => (e as Record<string, unknown>)?.id !== entryId);
      if (next.length === current.length) throw notFound("That stats entry");
    }
    writeHistory(tx, uid, next, hadLegacy);
  });
}
