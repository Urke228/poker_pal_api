import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * The featured-results showcase.
 *
 * A player picks finished tournaments to show on their public profile; the API
 * copies place and winnings from the real finalized standings. These tests pin
 * the property that makes the showcase trustworthy: the client's input can
 * choose and rename a result, but never invent or alter one.
 */

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

const docs = new Map<string, Record<string, unknown>>();
const writes: { path: string; data: Record<string, unknown> }[] = [];

vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase-admin/firestore")>();
  return {
    ...actual,
    getFirestore: () => ({
      collection: (collection: string) => ({
        doc: (id: string) => ({
          id,
          get: async () => {
            const data = docs.get(`${collection}/${id}`);
            return { exists: data !== undefined, id, data: () => data };
          },
          set: async (data: Record<string, unknown>) => {
            writes.push({ path: `${collection}/${id}`, data });
            docs.set(`${collection}/${id}`, {
              ...(docs.get(`${collection}/${id}`) ?? {}),
              ...data,
            });
          },
        }),
      }),
    }),
  };
});

const { createApp } = await import("../src/app");
const app = createApp();

const PLAYER = "player-uid";
const OTHER = "other-uid";
const TID = "t-1";

const as = (req: request.Test, uid: string) =>
  req.set("Authorization", `Bearer token:${uid}`);

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockImplementation(async (token: string) => ({
    uid: token.slice("token:".length),
    email: null,
  }));

  docs.clear();
  writes.length = 0;

  docs.set(`users/${PLAYER}`, { username: "Ada" });
  docs.set(`users/${OTHER}`, { username: "Grace" });
  docs.set(`tournaments/${TID}`, {
    name: "Friday game",
    dateTime: "2026-08-28T19:00:00.000Z",
    buyIn: 20,
    playerLimit: 8,
    payoutStructure: "standard",
    isPublic: true,
    createdBy: OTHER,
    participants: [PLAYER, OTHER],
    status: "finished",
    results: [
      { uid: PLAYER, name: "Ada", place: 1, winnings: 120 },
      { uid: OTHER, name: "Grace", place: 2, winnings: 40 },
    ],
  });
});

const putFeatured = (uid: string, items: unknown) =>
  as(request(app).put("/users/me/featured").send({ items }), uid);

describe("PUT /users/me/featured", () => {
  it("fills place and winnings from the real standings", async () => {
    const res = await putFeatured(PLAYER, [{ tournamentId: TID }]);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults).toEqual([
      {
        tournamentId: TID,
        name: "Friday game",
        date: "2026-08-28T19:00:00.000Z",
        place: 1,
        winnings: 120,
      },
    ]);
  });

  it("lets the player rename the card but nothing else", async () => {
    const res = await putFeatured(PLAYER, [
      { tournamentId: TID, name: "My greatest win" },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults[0]).toMatchObject({
      name: "My greatest win",
      place: 1,
      winnings: 120,
    });
  });

  it("ignores forged place and winnings in the request body", async () => {
    const res = await putFeatured(PLAYER, [
      { tournamentId: TID, place: 1, winnings: 999999 },
    ]);
    expect(res.status).toBe(200);
    // Whatever the client sent, the stored card carries the real result.
    expect(res.body.featuredResults[0].winnings).toBe(120);
    const stored = writes.find((w) => w.path === `users/${PLAYER}`);
    expect(
      (stored?.data.featuredResults as { winnings: number }[])[0].winnings,
    ).toBe(120);
  });

  it("skips a tournament the caller has no result in", async () => {
    docs.set(`users/no-result`, { username: "Railbird" });
    const res = await putFeatured("no-result", [{ tournamentId: TID }]);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults).toEqual([]);
  });

  it("clears the showcase with an empty list", async () => {
    await putFeatured(PLAYER, [{ tournamentId: TID }]);
    const res = await putFeatured(PLAYER, []);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults).toEqual([]);
  });

  it("rejects more than 12 items", async () => {
    const items = Array.from({ length: 13 }, (_, i) => ({ tournamentId: `t-${i}` }));
    const res = await putFeatured(PLAYER, items);
    expect(res.status).toBe(400);
  });

  it("404s on a tournament that does not exist", async () => {
    const res = await putFeatured(PLAYER, [{ tournamentId: "nope" }]);
    expect(res.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .put("/users/me/featured")
      .send({ items: [] });
    expect(res.status).toBe(401);
  });
});

describe("featured results in the public projections", () => {
  it("shows on GET /users/:id for anyone signed in", async () => {
    await putFeatured(PLAYER, [{ tournamentId: TID }]);
    const res = await as(request(app).get(`/users/${PLAYER}`), OTHER);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults).toHaveLength(1);
    expect(res.body.featuredResults[0]).toMatchObject({ place: 1, winnings: 120 });
    // The projection stays free of private financial history.
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("buyin");
    expect(body).not.toContain("rebuy");
  });

  it("shows on GET /users/me", async () => {
    await putFeatured(PLAYER, [{ tournamentId: TID }]);
    const res = await as(request(app).get("/users/me"), PLAYER);
    expect(res.status).toBe(200);
    expect(res.body.featuredResults).toHaveLength(1);
  });
});
