import {
  db,
  FieldValue,
  ROSTERS,
  TOURNAMENTS,
  asNumber,
} from "../lib/firestore";
import { badRequest, conflict, notFound } from "../lib/errors";
import type { PlayerSummary, Tournament } from "../types/models";
import { mapTournament, resolveUsernames } from "./tournaments";

/**
 * A tournament's players live in two places, and always have:
 *   - registered users in `tournaments/{id}.participants` (uids), and
 *   - guests without an account in `rosters/{tournamentId}.players[]`
 *     (entries whose `uid` is null).
 *
 * The mobile UI merged these by hand in the participants card. Doing it here
 * gives both clients one list and removes the N+1 username lookups.
 */

interface RosterPlayer {
  name: string;
  uid: string | null;
  buyInPaid: boolean;
  rebuys: number;
  addOns: number;
}

function mapRosterPlayer(raw: unknown): RosterPlayer {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    name: typeof p.name === "string" ? p.name : "",
    uid: typeof p.uid === "string" && p.uid ? p.uid : null,
    buyInPaid: p.buyInPaid === true,
    rebuys: asNumber(p.rebuys),
    addOns: asNumber(p.addOns),
  };
}

export async function readRosterPlayers(tournamentId: string): Promise<RosterPlayer[]> {
  const snap = await db().collection(ROSTERS).doc(tournamentId).get();
  if (!snap.exists) return [];
  const players = snap.data()?.players;
  return Array.isArray(players) ? players.map(mapRosterPlayer) : [];
}

async function writeRosterPlayers(
  tournamentId: string,
  t: Tournament,
  players: RosterPlayer[],
): Promise<void> {
  await db()
    .collection(ROSTERS)
    .doc(tournamentId)
    .set(
      {
        // Keep the roster's own metadata in sync so the mobile players screen
        // (which still reads this doc directly) stays correct.
        ownerId: t.createdBy,
        name: t.name,
        tournamentId,
        buyIn: t.buyIn,
        payoutStructure: t.payoutStructure,
        players,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
}

export async function listPlayers(t: Tournament): Promise<PlayerSummary[]> {
  const roster = await readRosterPlayers(t.id);
  const names = await resolveUsernames(t.participants);

  // Roster rows carry the payment tracking, so prefer them when present.
  const rosterByUid = new Map(
    roster.filter((p) => p.uid).map((p) => [p.uid as string, p]),
  );

  const registered: PlayerSummary[] = t.participants.map((uid) => {
    const r = rosterByUid.get(uid);
    return {
      id: uid,
      uid,
      name: r?.name || names.get(uid) || "Player",
      isGuest: false,
      buyInPaid: r?.buyInPaid ?? false,
      rebuys: r?.rebuys ?? 0,
      addOns: r?.addOns ?? 0,
    };
  });

  const guests: PlayerSummary[] = roster
    .filter((p) => p.uid === null)
    .map((p) => ({
      id: guestIdFor(p.name),
      uid: null,
      name: p.name,
      isGuest: true,
      buyInPaid: p.buyInPaid,
      rebuys: p.rebuys,
      addOns: p.addOns,
    }));

  return [...registered, ...guests];
}

/**
 * Roster guest rows have no stored id, so address them by their name. Names are
 * already unique within a roster because every insert path dedupes on
 * lowercased name.
 */
function guestIdFor(name: string): string {
  return `guest:${name.toLowerCase()}`;
}

export async function addPlayer(
  t: Tournament,
  input: { uid?: string; name?: string },
): Promise<PlayerSummary[]> {
  if (input.uid) {
    if (t.participants.includes(input.uid)) {
      throw conflict("ALREADY_JOINED", "That player is already in this tournament.");
    }
    if (t.playerLimit > 0 && t.participants.length >= t.playerLimit) {
      throw conflict("TOURNAMENT_FULL", "That tournament is full.");
    }
    const userSnap = await db().collection("users").doc(input.uid).get();
    if (!userSnap.exists) throw notFound("That player");
    await db()
      .collection(TOURNAMENTS)
      .doc(t.id)
      .update({ participants: FieldValue.arrayUnion(input.uid) });
    return listPlayers({ ...t, participants: [...t.participants, input.uid] });
  }

  const name = (input.name ?? "").trim();
  const roster = await readRosterPlayers(t.id);
  const names = await resolveUsernames(t.participants);
  const taken = new Set(
    [...roster.map((p) => p.name), ...names.values()].map((n) => n.toLowerCase()),
  );
  if (taken.has(name.toLowerCase())) {
    throw conflict("DUPLICATE_PLAYER", `${name} is already in this tournament.`);
  }
  const next = [...roster, { name, uid: null, buyInPaid: false, rebuys: 0, addOns: 0 }];
  await writeRosterPlayers(t.id, t, next);
  return listPlayers(t);
}

export async function updatePlayer(
  t: Tournament,
  playerId: string,
  patch: { name?: string; buyInPaid?: boolean; rebuys?: number; addOns?: number },
): Promise<PlayerSummary[]> {
  const roster = await readRosterPlayers(t.id);
  const isGuest = playerId.startsWith("guest:");
  const idx = isGuest
    ? roster.findIndex((p) => p.uid === null && guestIdFor(p.name) === playerId)
    : roster.findIndex((p) => p.uid === playerId);

  if (idx === -1) {
    // A registered participant with no roster row yet — materialize one so the
    // payment tracking has somewhere to live.
    if (!isGuest && t.participants.includes(playerId)) {
      const names = await resolveUsernames([playerId]);
      roster.push({
        name: patch.name ?? names.get(playerId) ?? "Player",
        uid: playerId,
        buyInPaid: patch.buyInPaid ?? false,
        rebuys: patch.rebuys ?? 0,
        addOns: patch.addOns ?? 0,
      });
      await writeRosterPlayers(t.id, t, roster);
      return listPlayers(t);
    }
    throw notFound("That player");
  }

  const current = roster[idx];
  roster[idx] = {
    ...current,
    name: patch.name?.trim() || current.name,
    buyInPaid: patch.buyInPaid ?? current.buyInPaid,
    rebuys: patch.rebuys ?? current.rebuys,
    addOns: patch.addOns ?? current.addOns,
  };
  await writeRosterPlayers(t.id, t, roster);
  return listPlayers(t);
}

export async function removePlayer(
  t: Tournament,
  playerId: string,
): Promise<PlayerSummary[]> {
  if (playerId.startsWith("guest:")) {
    const roster = await readRosterPlayers(t.id);
    const next = roster.filter((p) => !(p.uid === null && guestIdFor(p.name) === playerId));
    if (next.length === roster.length) throw notFound("That guest");
    await writeRosterPlayers(t.id, t, next);
    return listPlayers(t);
  }

  if (!t.participants.includes(playerId)) throw notFound("That player");
  await db()
    .collection(TOURNAMENTS)
    .doc(t.id)
    .update({ participants: FieldValue.arrayRemove(playerId) });
  // Drop their roster row too, so payment tracking does not linger.
  const roster = await readRosterPlayers(t.id);
  const next = roster.filter((p) => p.uid !== playerId);
  if (next.length !== roster.length) await writeRosterPlayers(t.id, t, next);

  return listPlayers({ ...t, participants: t.participants.filter((p) => p !== playerId) });
}

/** Prize pool the same way the roster and clock compute it. */
export function prizePool(t: Tournament, players: PlayerSummary[]): number {
  const entries = players.filter((p) => p.buyInPaid).length;
  const rebuys = players.reduce((sum, p) => sum + p.rebuys, 0);
  const addOns = players.reduce((sum, p) => sum + p.addOns, 0);
  return (entries + rebuys + addOns) * t.buyIn;
}

export function assertKnownPlayer(players: PlayerSummary[], uid?: string, guestName?: string) {
  if (uid && !players.some((p) => p.uid === uid)) {
    throw badRequest("UNKNOWN_PLAYER", "A result refers to someone who is not in this tournament.");
  }
  if (guestName && !players.some((p) => p.isGuest && p.name.toLowerCase() === guestName.toLowerCase())) {
    throw badRequest("UNKNOWN_PLAYER", `There is no guest called ${guestName} in this tournament.`);
  }
}
