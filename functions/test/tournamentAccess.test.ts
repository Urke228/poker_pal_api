import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Who may see and join a tournament.
 *
 * A public tournament is open to any signed-in user. A private one is a
 * secret-code arrangement: the organizer, the players already in it, and
 * whoever holds the code. Everyone else is told it does not exist.
 *
 * These run against the whole route including the Firestore read, so the
 * refusals are observed as real HTTP responses rather than as helper throws.
 */

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

const docs = new Map<string, Record<string, unknown>>();
/** Documents written back by the transaction, so join can be asserted. */
const writes: { path: string; data: Record<string, unknown> }[] = [];

const snapshotOf = (path: string, id: string) => {
  const data = docs.get(path);
  return { exists: data !== undefined, id, data: () => data, ref: { path } };
};

/** Minimal query support: the operators the tournament service actually uses. */
function matches(data: Record<string, unknown>, field: string, op: string, value: unknown) {
  const actual = data[field];
  if (op === "==") return actual === value;
  if (op === "array-contains") return Array.isArray(actual) && actual.includes(value);
  throw new Error(`unsupported operator in test double: ${op}`);
}

vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase-admin/firestore")>();

  const docHandle = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => snapshotOf(`${collection}/${id}`, id),
    update: async (data: Record<string, unknown>) => {
      writes.push({ path: `${collection}/${id}`, data });
    },
  });

  type Filter = { field: string; op: string; value: unknown };
  const queryHandle = (collection: string, filters: Filter[]) => ({
    where: (field: string, op: string, value: unknown) =>
      queryHandle(collection, [...filters, { field, op, value }]),
    limit: () => queryHandle(collection, filters),
    get: async () => {
      const prefix = `${collection}/`;
      const hits = [...docs.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .filter(([, data]) => filters.every((f) => matches(data, f.field, f.op, f.value)))
        .map(([path]) => snapshotOf(path, path.slice(prefix.length)));
      return { empty: hits.length === 0, docs: hits, size: hits.length };
    },
  });

  return {
    ...actual,
    getFirestore: () => ({
      collection: (collection: string) => ({
        doc: (id: string) => docHandle(collection, id),
        where: (field: string, op: string, value: unknown) =>
          queryHandle(collection, [{ field, op, value }]),
      }),
      getAll: async (...refs: { path: string; id: string }[]) =>
        refs.map((r) => snapshotOf(r.path, r.id)),
      runTransaction: async (
        fn: (tx: {
          get: (ref: { path: string; id: string }) => Promise<unknown>;
          update: (ref: { path: string }, data: Record<string, unknown>) => void;
        }) => Promise<void>,
      ) =>
        fn({
          get: async (ref) => snapshotOf(ref.path, ref.id),
          update: (ref, data) => writes.push({ path: ref.path, data }),
        }),
    }),
  };
});

const { createApp } = await import("../src/app");
const app = createApp();

const ORGANIZER = "organizer-uid";
const PARTICIPANT = "participant-uid";
const STRANGER = "stranger-uid";
const CODE = "ABC123";

/** Signs the caller in as whoever the token names. */
const tokenFor = (uid: string) => `token:${uid}`;
const as = (req: request.Test, uid: string) =>
  req.set("Authorization", `Bearer ${tokenFor(uid)}`);

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith("token:")) throw new Error("invalid token");
    return { uid: token.slice("token:".length), email: null };
  });

  docs.clear();
  writes.length = 0;

  const base = {
    name: "Friday game",
    buyIn: 20,
    playerLimit: 8,
    payoutStructure: "standard",
    description: "",
    rules: "",
    createdBy: ORGANIZER,
    participants: [PARTICIPANT],
    status: "open",
  };
  docs.set("tournaments/public-1", { ...base, isPublic: true });
  docs.set("tournaments/private-1", { ...base, isPublic: false, inviteCode: CODE });
  docs.set(`users/${ORGANIZER}`, { username: "Organizer" });
  docs.set(`users/${PARTICIPANT}`, { username: "Participant" });
  docs.set(`users/${STRANGER}`, { username: "Stranger" });
});

describe("public tournaments", () => {
  it("can be read by any signed-in user", async () => {
    const res = await as(request(app).get("/tournaments/public-1"), STRANGER);
    expect(res.status).toBe(200);
    expect(res.body.tournament.name).toBe("Friday game");
  });

  it("expose their player list to any signed-in user", async () => {
    const res = await as(request(app).get("/tournaments/public-1/players"), STRANGER);
    expect(res.status).toBe(200);
  });

  it("can be joined with no invite code", async () => {
    const res = await as(request(app).post("/tournaments/public-1/join"), STRANGER);
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.path === "tournaments/public-1")).toBe(true);
  });
});

describe("private tournaments — who may read", () => {
  it("the organizer may", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), ORGANIZER);
    expect(res.status).toBe(200);
  });

  it("an existing participant may", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), PARTICIPANT);
    expect(res.status).toBe(200);
  });

  it("an unrelated user may not, and is told it does not exist", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), STRANGER);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("the refusal leaks nothing about the tournament", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), STRANGER);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Friday game");
    expect(body).not.toContain(CODE);
    expect(body).not.toContain(ORGANIZER);
  });

  it("an unrelated user may not read the player list either", async () => {
    const res = await as(request(app).get("/tournaments/private-1/players"), STRANGER);
    expect(res.status).toBe(404);
    expect(res.body.players).toBeUndefined();
  });

  it("a correct invite code in the header grants a read", async () => {
    const res = await as(
      request(app).get("/tournaments/private-1").set("X-Tournament-Code", CODE),
      STRANGER,
    );
    expect(res.status).toBe(200);
    expect(res.body.tournament.name).toBe("Friday game");
  });

  it("the code is accepted case-insensitively and with surrounding space", async () => {
    const res = await as(
      request(app).get("/tournaments/private-1").set("X-Tournament-Code", " abc123 "),
      STRANGER,
    );
    expect(res.status).toBe(200);
  });

  it("a wrong invite code does not", async () => {
    const res = await as(
      request(app).get("/tournaments/private-1").set("X-Tournament-Code", "WRONG9"),
      STRANGER,
    );
    expect(res.status).toBe(404);
  });

  it("a correct code also opens the player list", async () => {
    const res = await as(
      request(app).get("/tournaments/private-1/players").set("X-Tournament-Code", CODE),
      STRANGER,
    );
    expect(res.status).toBe(200);
  });
});

describe("private tournaments — who may join", () => {
  it("cannot be joined by id alone", async () => {
    const res = await as(request(app).post("/tournaments/private-1/join"), STRANGER);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    // Nothing was written.
    expect(writes).toHaveLength(0);
  });

  it("cannot be joined with a wrong code", async () => {
    const res = await as(
      request(app).post("/tournaments/private-1/join").send({ inviteCode: "WRONG9" }),
      STRANGER,
    );
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  it("can be joined with the correct code in the body", async () => {
    const res = await as(
      request(app).post("/tournaments/private-1/join").send({ inviteCode: CODE }),
      STRANGER,
    );
    expect(res.status).toBe(200);
    expect(writes.some((w) => w.path === "tournaments/private-1")).toBe(true);
  });

  it("the organizer does not need to supply the code", async () => {
    const res = await as(request(app).post("/tournaments/private-1/join"), ORGANIZER);
    expect(res.status).toBe(200);
  });
});

describe("invite code exposure", () => {
  it("is returned to the organizer, who needs it to share", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), ORGANIZER);
    expect(res.body.tournament.inviteCode).toBe(CODE);
  });

  it("is withheld from a participant, who has no reason to pass it on", async () => {
    const res = await as(request(app).get("/tournaments/private-1"), PARTICIPANT);
    expect(res.status).toBe(200);
    expect(res.body.tournament.inviteCode).toBeUndefined();
  });

  it("is withheld even from someone who presented it", async () => {
    const res = await as(
      request(app).get("/tournaments/private-1").set("X-Tournament-Code", CODE),
      STRANGER,
    );
    expect(res.body.tournament.inviteCode).toBeUndefined();
  });

  it("is withheld from the by-code lookup", async () => {
    const res = await as(request(app).get(`/tournaments/by-code/${CODE}`), STRANGER);
    expect(res.status).toBe(200);
    expect(res.body.tournament.id).toBe("private-1");
    expect(res.body.tournament.inviteCode).toBeUndefined();
  });

  it("is never sent to a non-organizer in a list", async () => {
    const res = await as(request(app).get("/tournaments?filter=registered"), PARTICIPANT);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CODE);
  });
});

describe("unauthenticated access", () => {
  it("is refused before any tournament is looked at", async () => {
    expect((await request(app).get("/tournaments/public-1")).status).toBe(401);
    expect((await request(app).get("/tournaments/private-1")).status).toBe(401);
    expect((await request(app).post("/tournaments/public-1/join")).status).toBe(401);
  });
});
