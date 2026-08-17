import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import { db, FieldValue, USERS } from "../lib/firestore";
import { forbidden, notFound } from "../lib/errors";
import { getStats } from "../services/stats";
import { ensureProfileSchema } from "../validation/schemas";

export const usersRouter = Router();
usersRouter.use(requireAuth);

/** Default profile art, matching what the Flutter app bundles. */
const DEFAULT_AVATAR = "lib/assets/images/avatars/avatar1.png";
const DEFAULT_BACKGROUND = "lib/assets/images/backgrounds/background1.png";

usersRouter.get("/me", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const snap = await db().collection(USERS).doc(uid).get();
  const d = snap.data() ?? {};
  res.json({
    uid,
    email: req.email ?? d.email ?? null,
    username: typeof d.username === "string" ? d.username : null,
    photoURL: typeof d.photoURL === "string" ? d.photoURL : DEFAULT_AVATAR,
    hasProfile: snap.exists,
  });
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
    tournaments: [],
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
  });
});
