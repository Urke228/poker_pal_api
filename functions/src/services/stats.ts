import { db, USERS, asNumber } from "../lib/firestore";
import { notFound } from "../lib/errors";
import type { StatsEntry, StatsResponse } from "../types/models";
import { buildChart, computeOverview } from "./statsMath";

/**
 * Stats entries are an array field on `users/{uid}`, not a subcollection.
 * Field names are historical and deliberately preserved: `buyin` (lowercase
 * "i"), `rebuy` (singular, a money amount rather than a count), `title`, and
 * `date` as a plain `yyyy-MM-dd` string.
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

export async function readEntries(uid: string): Promise<StatsEntry[]> {
  const snap = await db().collection(USERS).doc(uid).get();
  if (!snap.exists) throw notFound("That user");
  const raw = snap.data()?.tournaments;
  return Array.isArray(raw) ? raw.map(mapEntry) : [];
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
  const ref = db().collection(USERS).doc(uid);
  const entry = {
    id: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    date: input.date,
    title: input.title.trim(),
    buyin: input.buyin,
    rebuy: input.rebuy,
    win: input.win,
  };

  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("That user");
    const current = Array.isArray(snap.data()?.tournaments) ? snap.data()!.tournaments : [];
    tx.update(ref, { tournaments: [...current, entry] });
  });

  return entry;
}

export async function deleteEntry(uid: string, entryId: string): Promise<void> {
  const ref = db().collection(USERS).doc(uid);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("That user");
    const current: unknown[] = Array.isArray(snap.data()?.tournaments)
      ? snap.data()!.tournaments
      : [];

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
    tx.update(ref, { tournaments: next });
  });
}
