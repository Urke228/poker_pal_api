import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import {
  db,
  FieldValue,
  Timestamp,
  TOURNAMENTS,
  USERS,
  asNumber,
  asStringArray,
  toIsoDate,
} from "../lib/firestore";
import { conflict, forbidden, notFound } from "../lib/errors";
import type {
  PayoutStructure,
  Tournament,
  TournamentDetail,
  TournamentResult,
  TournamentStatus,
} from "../types/models";

const INVITE_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateInviteCode(length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Fraction splits per structure. `manualPayouts` is stored as percentages
 * 0..100 and only converted to fractions here, matching how both clients
 * have always read the field.
 */
export function payoutFractions(
  structure: PayoutStructure,
  manualPayouts?: number[],
): number[] {
  switch (structure) {
    case "winner-takes-all":
      return [1];
    case "top-heavy":
      return [0.7, 0.2, 0.1];
    case "flat":
      return [0.4, 0.3, 0.2, 0.1];
    case "manual": {
      const pcts = (manualPayouts ?? []).filter((p) => p > 0);
      return pcts.length > 0 ? pcts.map((p) => p / 100) : [1];
    }
    case "standard":
    default:
      return [0.5, 0.3, 0.2];
  }
}

export function mapTournament(snap: DocumentSnapshot<DocumentData>): Tournament {
  const d = snap.data() ?? {};
  const structure = (d.payoutStructure as PayoutStructure) ?? "standard";
  const out: Tournament = {
    id: snap.id,
    name: typeof d.name === "string" ? d.name : "",
    dateTime: toIsoDate(d.dateTime),
    buyIn: asNumber(d.buyIn),
    playerLimit: typeof d.playerLimit === "number" ? d.playerLimit : 0,
    payoutStructure: structure,
    isPublic: d.isPublic === true,
    description: typeof d.description === "string" ? d.description : "",
    rules: typeof d.rules === "string" ? d.rules : "",
    allowRebuys: d.allowRebuys === true,
    allowAddons: d.allowAddons === true,
    lateRegistration: d.lateRegistration === true,
    createdBy: typeof d.createdBy === "string" ? d.createdBy : "",
    createdAt: toIsoDate(d.createdAt),
    participants: asStringArray(d.participants),
    // Tournaments created before finalization existed have no status field.
    status: (d.status as TournamentStatus) ?? "open",
  };
  if (Array.isArray(d.manualPayouts)) {
    out.manualPayouts = d.manualPayouts.filter((p: unknown): p is number => typeof p === "number");
  }
  if (typeof d.inviteCode === "string" && d.inviteCode.length > 0) {
    out.inviteCode = d.inviteCode;
  }
  if (Array.isArray(d.results)) {
    out.results = d.results as TournamentResult[];
    out.finalizedAt = toIsoDate(d.finalizedAt);
  }
  return out;
}

export async function getTournamentOrThrow(id: string) {
  const snap = await db().collection(TOURNAMENTS).doc(id).get();
  if (!snap.exists) throw notFound("That tournament");
  return snap;
}

export function assertOrganizer(t: Tournament, uid: string) {
  if (t.createdBy !== uid) {
    throw forbidden("Only the organizer can change this tournament.");
  }
}

/* ── Who may see a tournament ──────────────────────────────────────────────
 *
 * A public tournament is open to any signed-in user. A private one is a
 * secret-code arrangement, not an invitee list: the organizer shares a code and
 * whoever holds it gets in. So the people who may see it are the organizer, the
 * players already in it, and anyone presenting the right code.
 *
 * These checks live here rather than in the security rules because the Admin
 * SDK ignores rules entirely — every request the API serves is fully
 * privileged, so this is the only thing standing between a document id and its
 * contents.
 */

/** Invite codes are stored upper-case; compare them that way. */
function codeMatches(t: Tournament, code?: string): boolean {
  if (!t.inviteCode || !code) return false;
  return t.inviteCode.toUpperCase() === code.trim().toUpperCase();
}

export function canView(t: Tournament, uid: string, code?: string): boolean {
  if (t.isPublic) return true;
  if (t.createdBy === uid) return true;
  if (t.participants.includes(uid)) return true;
  return codeMatches(t, code);
}

/**
 * 404, not 403, when a private tournament is off limits.
 *
 * A tournament id is meant to be unguessable, so confirming that one exists is
 * itself a disclosure. (This differs from `/users/:id/stats`, which answers 403
 * precisely because a uid is *not* secret and denying its existence would
 * mislead without protecting anything.)
 */
export function assertCanView(t: Tournament, uid: string, code?: string) {
  if (!canView(t, uid, code)) throw notFound("That tournament");
}

/**
 * Joining a private tournament needs the code, even though the id alone was
 * once enough. Read access without join protection would be pointless: joining
 * is the action with consequences.
 *
 * 403 here rather than 404 because the caller has demonstrably reached the
 * tournament — they are being told the code is required, which is actionable.
 */
export function assertCanJoin(t: Tournament, uid: string, code?: string) {
  if (t.isPublic) return;
  if (t.createdBy === uid) return;
  // Already in it: join will report ALREADY_JOINED, which is clearer than
  // demanding a code they no longer need.
  if (t.participants.includes(uid)) return;
  if (codeMatches(t, code)) return;
  throw forbidden("This tournament is private. Enter its invite code to join.");
}

/**
 * Strips the invite code from a tournament unless the viewer owns it.
 *
 * The code is the credential that gates a private tournament, so it must not
 * ride along in ordinary responses — a participant listing their tournaments
 * has no need for it, and handing it out would let them pass it on.
 */
export function forViewer(t: Tournament, uid: string): Tournament {
  if (t.createdBy === uid) return t;
  const { inviteCode: _omitted, ...rest } = t;
  return rest;
}

/** Resolves uid -> username in one batched read instead of N round trips. */
export async function resolveUsernames(uids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(uids.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;

  // getAll has no documented cap but stay well inside request limits.
  const CHUNK = 100;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const refs = unique.slice(i, i + CHUNK).map((uid) => db().collection(USERS).doc(uid));
    const snaps = await db().getAll(...refs);
    for (const snap of snaps) {
      const username = snap.data()?.username;
      out.set(snap.id, typeof username === "string" && username ? username : "Player");
    }
  }
  return out;
}

export async function toDetail(
  t: Tournament,
  guestCount: number,
): Promise<TournamentDetail> {
  const names = await resolveUsernames([t.createdBy]);
  return {
    ...t,
    organizerName: names.get(t.createdBy) ?? "Player",
    participantCount: t.participants.length,
    guestCount,
  };
}

export type TournamentFilter = "mine" | "registered" | "public" | "all";

export async function listTournaments(
  uid: string,
  filter: TournamentFilter,
): Promise<Tournament[]> {
  const col = db().collection(TOURNAMENTS);
  const byId = new Map<string, Tournament>();

  const collect = async (q: FirebaseFirestore.Query) => {
    const snap = await q.get();
    for (const doc of snap.docs) byId.set(doc.id, mapTournament(doc));
  };

  if (filter === "mine" || filter === "all") {
    await collect(col.where("createdBy", "==", uid));
  }
  if (filter === "registered" || filter === "all") {
    await collect(col.where("participants", "array-contains", uid));
  }
  if (filter === "public" || filter === "all") {
    await collect(col.where("isPublic", "==", true));
  }

  let out = [...byId.values()];
  // "public" means *joinable by me* — exclude what I run or already joined,
  // mirroring the client-side filter the mobile list has always applied.
  if (filter === "public") {
    out = out.filter((t) => t.createdBy !== uid && !t.participants.includes(uid));
  }
  out.sort((a, b) => {
    const at = a.dateTime ? Date.parse(a.dateTime) : 0;
    const bt = b.dateTime ? Date.parse(b.dateTime) : 0;
    return bt - at;
  });
  return out;
}

export async function findByInviteCode(code: string): Promise<Tournament | null> {
  const snap = await db()
    .collection(TOURNAMENTS)
    .where("inviteCode", "==", code.trim().toUpperCase())
    .limit(1)
    .get();
  return snap.empty ? null : mapTournament(snap.docs[0]);
}

/**
 * Joining races against the player limit, so the read and the write have to
 * happen in one transaction — this is the invariant the mobile client could
 * only ever enforce optimistically.
 */
export async function joinTournament(
  id: string,
  uid: string,
  inviteCode?: string,
): Promise<Tournament> {
  const ref = db().collection(TOURNAMENTS).doc(id);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("That tournament");
    const t = mapTournament(snap);
    // Re-checked inside the transaction against the current document, so a
    // tournament flipped to private mid-request cannot be joined on a stale read.
    assertCanJoin(t, uid, inviteCode);
    if (t.status === "finished") {
      throw conflict("TOURNAMENT_FINISHED", "That tournament has already finished.");
    }
    if (t.participants.includes(uid)) {
      throw conflict("ALREADY_JOINED", "You have already joined this tournament.");
    }
    if (t.playerLimit > 0 && t.participants.length >= t.playerLimit) {
      throw conflict("TOURNAMENT_FULL", "That tournament is full.");
    }
    tx.update(ref, { participants: FieldValue.arrayUnion(uid) });
  });
  return mapTournament(await ref.get());
}

export async function leaveTournament(id: string, uid: string): Promise<Tournament> {
  const ref = db().collection(TOURNAMENTS).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw notFound("That tournament");
  if (mapTournament(snap).status === "finished") {
    throw conflict("TOURNAMENT_FINISHED", "That tournament has already finished.");
  }
  await ref.update({ participants: FieldValue.arrayRemove(uid) });
  return mapTournament(await ref.get());
}

export interface TournamentWriteInput {
  name: string;
  dateTime: string;
  buyIn: number;
  playerLimit: number;
  payoutStructure: PayoutStructure;
  manualPayouts?: number[];
  isPublic: boolean;
  inviteCode?: string;
  description: string;
  rules: string;
  allowRebuys: boolean;
  allowAddons: boolean;
  lateRegistration: boolean;
}

/**
 * Shared field mapping for create and update.
 *
 * `manualPayouts` and `inviteCode` are *absent* rather than null when they do
 * not apply — on update that means an explicit delete, which is the convention
 * the mobile app established and the stored documents rely on.
 */
function writeFields(input: TournamentWriteInput, forUpdate: boolean) {
  const data: Record<string, unknown> = {
    name: input.name.trim(),
    dateTime: Timestamp.fromDate(new Date(input.dateTime)),
    buyIn: input.buyIn,
    playerLimit: input.playerLimit,
    payoutStructure: input.payoutStructure,
    isPublic: input.isPublic,
    description: input.description.trim(),
    rules: input.rules.trim(),
    allowRebuys: input.allowRebuys,
    allowAddons: input.allowAddons,
    lateRegistration: input.lateRegistration,
  };

  if (input.payoutStructure === "manual" && input.manualPayouts?.length) {
    data.manualPayouts = input.manualPayouts;
  } else if (forUpdate) {
    data.manualPayouts = FieldValue.delete();
  }

  if (!input.isPublic) {
    const code = input.inviteCode?.trim().toUpperCase();
    data.inviteCode = code && code.length > 0 ? code : generateInviteCode();
  } else if (forUpdate) {
    data.inviteCode = FieldValue.delete();
  }

  return data;
}

export async function createTournament(
  uid: string,
  input: TournamentWriteInput & { organizerIsPlaying: boolean; groupMemberUids: string[] },
): Promise<Tournament> {
  const participants = [
    ...new Set([...(input.organizerIsPlaying ? [uid] : []), ...input.groupMemberUids]),
  ];
  const ref = await db()
    .collection(TOURNAMENTS)
    .add({
      ...writeFields(input, false),
      // Ownership comes from the verified token, never from the request body.
      createdBy: uid,
      createdAt: FieldValue.serverTimestamp(),
      participants,
      status: "open",
    });
  return mapTournament(await ref.get());
}

export async function updateTournament(
  id: string,
  uid: string,
  input: TournamentWriteInput,
): Promise<Tournament> {
  const snap = await getTournamentOrThrow(id);
  assertOrganizer(mapTournament(snap), uid);
  // createdBy, createdAt and participants are intentionally never rewritten.
  await snap.ref.update(writeFields(input, true));
  return mapTournament(await snap.ref.get());
}

export async function deleteTournament(id: string, uid: string): Promise<void> {
  const snap = await getTournamentOrThrow(id);
  assertOrganizer(mapTournament(snap), uid);
  await snap.ref.delete();
}
