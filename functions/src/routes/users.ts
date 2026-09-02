import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import { db, FieldValue, USERS } from "../lib/firestore";
import { forbidden, notFound } from "../lib/errors";
import { getStats } from "../services/stats";
import {
  assertCanView,
  getTournamentOrThrow,
  mapTournament,
} from "../services/tournaments";
import { ensureProfileSchema, featuredSchema } from "../validation/schemas";

export const usersRouter = Router();
usersRouter.use(requireAuth);

/** Default profile art, matching what the Flutter app bundles. */
const DEFAULT_AVATAR = "lib/assets/images/avatars/avatar1.png";
const DEFAULT_BACKGROUND = "lib/assets/images/backgrounds/background1.png";

/**
 * The public showcase: results a player chose to display on their profile.
 * Written only by PUT /me/featured below, so the fields are authoritative —
 * safe by construction (no buy-in or rebuy amounts), but still normalized on
 * the way out so a malformed doc never leaks anything else.
 */
function mapFeatured(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return {
      tournamentId: typeof r.tournamentId === "string" ? r.tournamentId : "",
      name: typeof r.name === "string" ? r.name : "",
      date: typeof r.date === "string" ? r.date : null,
      place: typeof r.place === "number" ? r.place : null,
      winnings: typeof r.winnings === "number" ? r.winnings : 0,
    };
  });
}

usersRouter.get("/me", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const snap = await db().collection(USERS).doc(uid).get();
  const d = snap.data() ?? {};
  res.json({
    uid,
    email: req.email ?? d.email ?? null,
    username: typeof d.username === "string" ? d.username : null,
    photoURL: typeof d.photoURL === "string" ? d.photoURL : DEFAULT_AVATAR,
    backgroundURL: typeof d.backgroundURL === "string" ? d.backgroundURL : DEFAULT_BACKGROUND,
    // Counts, not uids — the web profile only shows the numbers.
    followers: Array.isArray(d.followers) ? d.followers.length : 0,
    following: Array.isArray(d.following) ? d.following.length : 0,
    hasProfile: snap.exists,
    featuredResults: mapFeatured(d.featuredResults),
  });
});

/**
 * Sets which finished tournaments show on the caller's public profile.
 *
 * The client sends only tournament ids (plus an optional display name); the
 * place and winnings are looked up in the real finalized standings here, so a
 * player cannot fabricate a result — they can only choose to show one they
 * actually earned. Items with no result for this player are skipped rather
 * than rejected, so a stale selection never blocks the rest.
 */
usersRouter.put("/me/featured", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const { items } = featuredSchema.parse(req.body ?? {});

  const seen = new Set<string>();
  const featured: Array<Record<string, unknown>> = [];
  for (const item of items) {
    if (seen.has(item.tournamentId)) continue;
    seen.add(item.tournamentId);

    const t = mapTournament(await getTournamentOrThrow(item.tournamentId));
    assertCanView(t, uid);
    const result = (t.results ?? []).find((r) => r.uid === uid);
    if (!result) continue;

    featured.push({
      tournamentId: t.id,
      name: item.name?.trim() || t.name,
      date: t.dateTime,
      place: result.place,
      winnings: result.winnings,
    });
  }

  await db().collection(USERS).doc(uid).set({ featuredResults: featured }, { merge: true });
  res.json({ featuredResults: featured });
});

/**
 * Creates `users/{uid}` on first sign-in if it is missing.
 *
 * Both clients used to carry their own copy of this document shape; keeping it
 * here means a profile created on web is identical to one created on mobile.
 */
usersRouter.post("/ensure-profile", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const ref = db().collection(USERS).doc(uid);
  const snap = await ref.get();
  if (snap.exists) {
    res.json({ created: false });
    return;
  }

  const { username: requested } = ensureProfileSchema.parse(req.body ?? {});
  const fallback = (req.email ?? "").split("@")[0];
  const username = requested || fallback || "Player";

  await ref.set({
    username,
    username_lowercase: username.toLowerCase(),
    email: req.email ?? null,
    joinedAt: FieldValue.serverTimestamp(),
    followers: [],
    following: [],
    photoURL: DEFAULT_AVATAR,
    backgroundURL: DEFAULT_BACKGROUND,
  });
  res.status(201).json({ created: true, username });
});

/**
 * A player's own statistics, addressed by uid.
 *
 * This is private financial history — every buy-in, rebuy and payout — so it is
 * readable only by its owner. Requesting anyone else's is a 403 rather than a
 * 404: the uid is not a secret (it appears in participant lists), so pretending
 * the user does not exist would be misleading without protecting anything.
 *
 * There is deliberately no public projection of this data. Nothing in either
 * client shows another player's results, so exposing a reduced form would add
 * an unused surface. `/stats/me` remains the endpoint both clients actually
 * use; this one exists so statistics are addressable as a sub-resource of a
 * user, which is why it enforces the same ownership rule.
 */
usersRouter.get("/:id/stats", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  if (req.params.id !== uid) {
    throw forbidden("You can only view your own statistics.");
  }
  res.json(await getStats(uid));
});

usersRouter.get("/:id", async (req, res) => {
  const snap = await db().collection(USERS).doc(req.params.id).get();
  if (!snap.exists) throw notFound("That user");
  const d = snap.data() ?? {};
  res.json({
    uid: snap.id,
    username: typeof d.username === "string" ? d.username : "Player",
    photoURL: typeof d.photoURL === "string" ? d.photoURL : DEFAULT_AVATAR,
    featuredResults: mapFeatured(d.featuredResults),
  });
});
