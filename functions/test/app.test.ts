import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Route-level tests for the parts that run BEFORE any Firestore access:
 * authentication, the error envelope, and request validation. Only the Admin
 * Auth SDK is stubbed, so no emulator or network is needed and the suite stays
 * fast. Domain rules are covered directly in the service tests.
 */
const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ verifyIdToken }),
}));

const { createApp } = await import("../src/app");
const app = createApp();

const GOOD_TOKEN = "good-token";

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockImplementation(async (token: string) => {
    if (token !== GOOD_TOKEN) throw new Error("invalid token");
    return { uid: "organizer", email: "organizer@example.com" };
  });
});

const auth = (req: request.Test) => req.set("Authorization", `Bearer ${GOOD_TOKEN}`);

describe("GET /health", () => {
  it("is public and reports ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("authentication", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a malformed Authorization header", async () => {
    const res = await request(app).get("/me").set("Authorization", "not-a-bearer-token");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects an expired or invalid token", async () => {
    const res = await request(app).get("/me").set("Authorization", "Bearer stale");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns the identity from the verified token", async () => {
    const res = await auth(request(app).get("/me"));
    expect(res.status).toBe(200);
    expect(res.body.uid).toBe("organizer");
  });

  it("guards the tournament routes too", async () => {
    expect((await request(app).get("/tournaments")).status).toBe(401);
    expect((await request(app).post("/tournaments").send({})).status).toBe(401);
    expect((await request(app).get("/stats/me")).status).toBe(401);
    expect((await request(app).get("/groups")).status).toBe(401);
  });
});

describe("request validation", () => {
  const validBody = {
    name: "Friday game",
    dateTime: "2026-09-01T19:00:00.000Z",
    buyIn: 20,
    playerLimit: 8,
    payoutStructure: "standard",
    isPublic: true,
    description: "",
    rules: "",
    allowRebuys: false,
    allowAddons: false,
    lateRegistration: false,
  };

  it("rejects an empty body with a 400 and a stable code", async () => {
    const res = await auth(request(app).post("/tournaments").send({}));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(typeof res.body.error.message).toBe("string");
  });

  it("rejects a negative buy-in before touching the database", async () => {
    const res = await auth(
      request(app).post("/tournaments").send({ ...validBody, buyIn: -5 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.message).toContain("buyIn");
  });

  it("rejects an unknown payout structure", async () => {
    const res = await auth(
      request(app).post("/tournaments").send({ ...validBody, payoutStructure: "pyramid" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a manual structure with no percentages", async () => {
    const res = await auth(
      request(app).post("/tournaments").send({ ...validBody, payoutStructure: "manual" }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("manualPayouts");
  });

  it("rejects a stats entry whose date is not yyyy-MM-dd", async () => {
    const res = await auth(
      request(app)
        .post("/stats/entries")
        .send({ date: "01/09/2026", title: "Game", buyin: 20, rebuy: 0, win: 0 }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("date");
  });

  it("rejects a player that is neither a uid nor a guest name", async () => {
    const res = await auth(request(app).post("/tournaments/t1/players").send({}));
    expect(res.status).toBe(400);
  });
});

describe("unknown routes", () => {
  it("returns a 404 in the same error envelope", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
