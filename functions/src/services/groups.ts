import type { DocumentData, DocumentSnapshot } from "firebase-admin/firestore";
import { db, FieldValue, GROUPS, asStringArray } from "../lib/firestore";
import { conflict, forbidden, notFound } from "../lib/errors";
import type { Group, GroupGuest } from "../types/models";

function mapGroup(snap: DocumentSnapshot<DocumentData>): Group {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    name: typeof d.name === "string" ? d.name : "",
    ownerId: typeof d.ownerId === "string" ? d.ownerId : "",
    memberUids: asStringArray(d.memberUids),
    pendingInvites: asStringArray(d.pendingInvites),
    guests: Array.isArray(d.guests)
      ? d.guests
          .map((g: unknown) => g as Record<string, unknown>)
          .filter((g) => typeof g?.id === "string" && typeof g?.name === "string")
          .map((g) => ({ id: g.id as string, name: g.name as string }))
      : [],
  };
}

async function getOrThrow(id: string) {
  const snap = await db().collection(GROUPS).doc(id).get();
  if (!snap.exists) throw notFound("That group");
  return snap;
}

function assertOwner(g: Group, uid: string) {
  if (g.ownerId !== uid) throw forbidden("Only the group owner can do that.");
}

function assertVisible(g: Group, uid: string) {
  const visible =
    g.ownerId === uid || g.memberUids.includes(uid) || g.pendingInvites.includes(uid);
  if (!visible) throw notFound("That group");
}

export async function listGroups(uid: string): Promise<Group[]> {
  const col = db().collection(GROUPS);
  const [owned, member, invited] = await Promise.all([
    col.where("ownerId", "==", uid).get(),
    col.where("memberUids", "array-contains", uid).get(),
    col.where("pendingInvites", "array-contains", uid).get(),
  ]);
  const byId = new Map<string, Group>();
  for (const snap of [...owned.docs, ...member.docs, ...invited.docs]) {
    byId.set(snap.id, mapGroup(snap));
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getGroup(id: string, uid: string): Promise<Group> {
  const g = mapGroup(await getOrThrow(id));
  assertVisible(g, uid);
  return g;
}

export async function createGroup(uid: string, name: string): Promise<Group> {
  const ref = await db().collection(GROUPS).add({
    name: name.trim(),
    ownerId: uid,
    memberUids: [uid],
    pendingInvites: [],
    guests: [] as GroupGuest[],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return mapGroup(await ref.get());
}

export async function renameGroup(id: string, uid: string, name: string): Promise<Group> {
  const snap = await getOrThrow(id);
  assertOwner(mapGroup(snap), uid);
  await snap.ref.update({ name: name.trim(), updatedAt: FieldValue.serverTimestamp() });
  return mapGroup(await snap.ref.get());
}

export async function deleteGroup(id: string, uid: string): Promise<void> {
  const snap = await getOrThrow(id);
  assertOwner(mapGroup(snap), uid);
  await snap.ref.delete();
}

export async function inviteToGroup(
  id: string,
  uid: string,
  targetUid: string,
): Promise<Group> {
  const snap = await getOrThrow(id);
  const g = mapGroup(snap);
  assertOwner(g, uid);
  if (g.memberUids.includes(targetUid)) {
    throw conflict("ALREADY_MEMBER", "That player is already in this group.");
  }
  if (g.pendingInvites.includes(targetUid)) {
    throw conflict("ALREADY_INVITED", "That player has already been invited.");
  }
  const target = await db().collection("users").doc(targetUid).get();
  if (!target.exists) throw notFound("That player");

  await snap.ref.update({
    pendingInvites: FieldValue.arrayUnion(targetUid),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return mapGroup(await snap.ref.get());
}

/** Accept moves the caller from pendingInvites into memberUids atomically. */
export async function acceptInvite(id: string, uid: string): Promise<Group> {
  const ref = db().collection(GROUPS).doc(id);
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw notFound("That group");
    const g = mapGroup(snap);
    if (!g.pendingInvites.includes(uid)) {
      throw conflict("NO_INVITE", "You do not have a pending invite to that group.");
    }
    tx.update(ref, {
      pendingInvites: FieldValue.arrayRemove(uid),
      memberUids: FieldValue.arrayUnion(uid),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
  return mapGroup(await ref.get());
}

export async function declineInvite(id: string, uid: string): Promise<void> {
  const snap = await getOrThrow(id);
  if (!mapGroup(snap).pendingInvites.includes(uid)) {
    throw conflict("NO_INVITE", "You do not have a pending invite to that group.");
  }
  await snap.ref.update({
    pendingInvites: FieldValue.arrayRemove(uid),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** The owner removes anyone; a member may remove only themselves. */
export async function removeMember(
  id: string,
  uid: string,
  targetUid: string,
): Promise<Group> {
  const snap = await getOrThrow(id);
  const g = mapGroup(snap);
  if (g.ownerId !== uid && targetUid !== uid) {
    throw forbidden("You can only remove yourself from a group.");
  }
  if (targetUid === g.ownerId) {
    throw conflict("OWNER_CANNOT_LEAVE", "The owner cannot leave their own group.");
  }
  await snap.ref.update({
    memberUids: FieldValue.arrayRemove(targetUid),
    updatedAt: FieldValue.serverTimestamp(),
  });
  return mapGroup(await snap.ref.get());
}

export async function addGuest(id: string, uid: string, name: string): Promise<Group> {
  const snap = await getOrThrow(id);
  const g = mapGroup(snap);
  assertOwner(g, uid);
  const trimmed = name.trim();
  if (g.guests.some((x) => x.name.toLowerCase() === trimmed.toLowerCase())) {
    throw conflict("DUPLICATE_GUEST", `${trimmed} is already a guest in this group.`);
  }
  const guest: GroupGuest = {
    id: `${Date.now()}${Math.floor(Math.random() * 1e6)}`,
    name: trimmed,
  };
  await snap.ref.update({
    guests: [...g.guests, guest],
    updatedAt: FieldValue.serverTimestamp(),
  });
  return mapGroup(await snap.ref.get());
}

export async function removeGuest(id: string, uid: string, guestId: string): Promise<Group> {
  const snap = await getOrThrow(id);
  const g = mapGroup(snap);
  assertOwner(g, uid);
  const next = g.guests.filter((x) => x.id !== guestId);
  if (next.length === g.guests.length) throw notFound("That guest");
  await snap.ref.update({ guests: next, updatedAt: FieldValue.serverTimestamp() });
  return mapGroup(await snap.ref.get());
}
