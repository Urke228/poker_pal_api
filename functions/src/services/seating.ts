import { db, FieldValue, SEATINGS, toIsoDate } from "../lib/firestore";
import type { Tournament } from "../types/models";

/**
 * A published seating chart for a tournament, stored at `seatings/{tournamentId}`
 * (one doc per tournament, parallel to `rosters/{tournamentId}`).
 *
 * The organizer app generates seating and publishes it here; the web display
 * reads it back through the REST API. Like `tournaments`, the collection is
 * API-only (see firestore.rules) — clients never touch it directly, so the same
 * `assertCanView`/`assertOrganizer` checks the routes already use are the only
 * gate.
 *
 * On the wire (POST body and GET response) `tables[t][s]` is the seated player's
 * display name, or null for an empty seat; table number is `t + 1`, seat is
 * `s + 1`. Firestore forbids nested arrays, so the stored document wraps each
 * table as `{ seats: [...] }` — this module maps between the two.
 */
export interface Seating {
  tables: (string | null)[][];
  publishedAt: string | null;
}

/** Empty strings and non-strings collapse to null so an empty seat is uniform. */
function normalizeSeats(seats: unknown): (string | null)[] {
  if (!Array.isArray(seats)) return [];
  return seats.map((seat) =>
    typeof seat === "string" && seat.trim().length > 0 ? seat.trim() : null,
  );
}

/** Wire nested array → normalized nested array. */
function normalizeTables(tables: unknown): (string | null)[][] {
  return Array.isArray(tables) ? tables.map(normalizeSeats) : [];
}

/**
 * Shapes a stored `seatings/{id}` document (tables as `{ seats }` objects) into
 * the flat nested-array wire response.
 */
export function mapSeatingDoc(raw: unknown): Seating | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const stored = Array.isArray(data.tables) ? data.tables : [];
  const tables = stored.map((table) =>
    normalizeSeats(
      table && typeof table === "object" ? (table as Record<string, unknown>).seats : [],
    ),
  );
  return { tables, publishedAt: toIsoDate(data.publishedAt) };
}

export async function readSeating(tournamentId: string): Promise<Seating | null> {
  const snap = await db().collection(SEATINGS).doc(tournamentId).get();
  if (!snap.exists) return null;
  return mapSeatingDoc(snap.data());
}

export async function publishSeating(
  t: Tournament,
  publishedBy: string,
  tables: (string | null)[][],
): Promise<Seating> {
  const normalized = normalizeTables(tables);
  await db().collection(SEATINGS).doc(t.id).set({
    tournamentId: t.id,
    ownerId: t.createdBy,
    publishedBy,
    // Firestore rejects nested arrays, so each table is stored as { seats: [...] }.
    tables: normalized.map((seats) => ({ seats })),
    publishedAt: FieldValue.serverTimestamp(),
  });
  // publishedAt is written server-side; echo the current time so the caller has
  // a value without a second read.
  return { tables: normalized, publishedAt: new Date().toISOString() };
}

export async function clearSeating(tournamentId: string): Promise<void> {
  await db().collection(SEATINGS).doc(tournamentId).delete();
}
