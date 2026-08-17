import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Access control on a player's statistics.
 *
 * A user's results history is private financial data — buy-ins, rebuys and
 * payouts — so it must only ever reach its owner. These tests cover the whole
 * route, including the Firestore read, so both the success and the refusal are
 * exercised rather than only the guard.
 */

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

/** `collection/doc` -> document data, or absent for a document that does not exist. */
const docs = new Map<string, Record<string, unknown>>();

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
        }),
      }),
    }),
  };
});

const { createApp } = await import("../src/app");
const app = createApp();

const OWNER = "owner-uid";
const OTHER = "other-uid";
const TOKEN = "owner-token";

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token !== TOKEN) throw new Error("invalid token");
    return { uid: OWNER, email: "owner@example.com" };
  });

  docs.clear();
  docs.set(`users/${OWNER}`, {
    username: "Owner",
    tournaments: [
      { id: "e1", date: "2026-08-01", title: "Friday game", buyin: 20, rebuy: 0, win: 80 },
    ],
  });
  docs.set(`users/${OTHER}`, {
    username: "Someone Else",
    tournaments: [
      { id: "e2", date: "2026-08-02", title: "Their game", buyin: 50, rebuy: 25, win: 0 },
    ],
  });
});

const asOwner = (req: request.Test) => req.set("Authorization", `Bearer ${TOKEN}`);

describe("GET /users/:id/stats", () => {
  it("returns the caller's own statistics", async () => {
    const res = await asOwner(request(app).get(`/users/${OWNER}/stats`));
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].title).toBe("Friday game");
    expect(res.body.overview.totalWin).toBe(80);
  });

  it("refuses another user's statistics with 403", async () => {
    const res = await asOwner(request(app).get(`/users/${OTHER}/stats`));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("leaks nothing about the other user in the refusal", async () => {
    const res = await asOwner(request(app).get(`/users/${OTHER}/stats`));
    const body = JSON.stringify(res.body);
    // No entries, no totals, not even their name.
    expect(body).not.toContain("Their game");
    expect(body).not.toContain("Someone Else");
    expect(res.body.entries).toBeUndefined();
    expect(res.body.overview).toBeUndefined();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get(`/users/${OWNER}/stats`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an invalid token", async () => {
    const res = await request(app)
      .get(`/users/${OWNER}/stats`)
      .set("Authorization", "Bearer stale");
    expect(res.status).toBe(401);
  });
});

describe("GET /stats/me", () => {
  it("still serves the caller their own private statistics", async () => {
    const res = await asOwner(request(app).get("/stats/me"));
    expect(res.status).toBe(200);
    expect(res.body.entries[0].title).toBe("Friday game");
  });

  it("is unreachable without a token", async () => {
    const res = await request(app).get("/stats/me");
    expect(res.status).toBe(401);
  });

  it("cannot be pointed at another user — there is no parameter to change", async () => {
    // The uid comes from the token, so the only way to read someone else's
    // history would be to hold their token.
    const res = await asOwner(request(app).get("/stats/me"));
    expect(JSON.stringify(res.body)).not.toContain("Their game");
  });
});
