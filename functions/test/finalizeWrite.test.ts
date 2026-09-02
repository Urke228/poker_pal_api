import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * What finalization actually writes.
 *
 * The pure rules are covered in finalize.test.ts; this drives the whole
 * endpoint through the transaction so the documents it produces are asserted
 * rather than assumed. It is also the only test that exercises a Firestore
 * transaction at all.
 */

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

const docs = new Map<string, Record<string, unknown>>();
const writes: { path: string; data: Record<string, unknown> }[] = [];

const snapshotOf = (path: string, id: string) => {
  const data = docs.get(path);
  return { exists: data !== undefined, id, data: () => data, ref: { path, id } };
};

vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase-admin/firestore")>();
  const docHandle = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => snapshotOf(`${collection}/${id}`, id),
    set: async (data: Record<string, unknown>) => {
      writes.push({ path: `${collection}/${id}`, data });
    },
    update: async (data: Record<string, unknown>) => {
      writes.push({ path: `${collection}/${id}`, data });
    },
  });
  return {
    ...actual,
    getFirestore: () => ({
      collection: (collection: string) => ({ doc: (id: string) => docHandle(collection, id) }),
      getAll: async (...refs: { path: string; id: string }[]) =>
        refs.map((r) => snapshotOf(r.path, r.id)),
      runTransaction: async (
        fn: (tx: {
          get: (ref: { path: string; id: string }) => Promise<unknown>;
          getAll: (...refs: { path: string; id: string }[]) => Promise<unknown[]>;
          update: (ref: { path: string }, data: Record<string, unknown>) => void;
          set: (ref: { path: string }, data: Record<string, unknown>, opts?: unknown) => void;
        }) => Promise<void>,
      ) =>
        fn({
          get: async (ref) => snapshotOf(ref.path, ref.id),
          getAll: async (...refs) => refs.map((r) => snapshotOf(r.path, r.id)),
          update: (ref, data) => writes.push({ path: ref.path, data }),
          set: (ref, data) => writes.push({ path: ref.path, data }),
        }),
    }),
  };
});

const { createApp } = await import("../src/app");
const app = createApp();

const ORGANIZER = "organizer-uid";
const WINNER = "winner-uid";
const RUNNER_UP = "runner-up-uid";
const TID = "t-1";

const as = (req: request.Test, uid: string) =>
  req.set("Authorization", `Bearer token:${uid}`);

/**
 * The entry appended to a player's history by the last write touching them.
 * History rows live in the owner-only `stats/{uid}` doc, not the public
 * profile — that relocation is exactly what the leak fix is about.
 */
const historyFor = (uid: string) => {
  const write = [...writes].reverse().find((w) => w.path === `stats/${uid}`);
  const list = (write?.data.tournaments ?? []) as Record<string, unknown>[];
  return list[list.length - 1];
};

beforeEach(() => {
  verifyIdToken.mockReset();
  verifyIdToken.mockImplementation(async (token: string) => ({
    uid: token.slice("token:".length),
    email: null,
  }));

  docs.clear();
  writes.length = 0;

  docs.set(`tournaments/${TID}`, {
    name: "Friday game",
    buyIn: 20,
    playerLimit: 8,
    payoutStructure: "standard",
    isPublic: true,
    createdBy: ORGANIZER,
    participants: [WINNER, RUNNER_UP],
    status: "open",
  });
  // Both paid in; the winner rebought once, which the entry must price.
  docs.set(`rosters/${TID}`, {
    ownerId: ORGANIZER,
    tournamentId: TID,
    buyIn: 20,
    players: [
      { name: "Ada", uid: WINNER, buyInPaid: true, rebuys: 1, addOns: 0 },
      { name: "Grace", uid: RUNNER_UP, buyInPaid: true, rebuys: 0, addOns: 0 },
      { name: "Steve", uid: null, buyInPaid: true, rebuys: 0, addOns: 0 },
    ],
  });
  docs.set(`users/${WINNER}`, { username: "Ada", tournaments: [] });
  docs.set(`users/${RUNNER_UP}`, { username: "Grace", tournaments: [] });
  docs.set(`users/${ORGANIZER}`, { username: "Organizer", tournaments: [] });
});

const finalize = () =>
  as(
    request(app)
      .post(`/tournaments/${TID}/finalize`)
      .send({
        results: [
          { uid: WINNER, place: 1, winnings: 60 },
          { uid: RUNNER_UP, place: 2, winnings: 20 },
          { guestName: "Steve", place: 3, winnings: 0 },
        ],
      }),
    ORGANIZER,
  );

describe("finalization writes", () => {
  it("succeeds and reports the standings in finishing order", async () => {
    const res = await finalize();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("finished");
    expect(res.body.results.map((r: { place: number }) => r.place)).toEqual([1, 2, 3]);
  });

  it("closes the tournament and stores the standings on it", async () => {
    await finalize();
    const write = writes.find((w) => w.path === `tournaments/${TID}`);
    expect(write?.data.status).toBe("finished");
    expect((write?.data.results as unknown[]).length).toBe(3);
  });

  it("links each history entry back to its tournament and place", async () => {
    await finalize();
    const entry = historyFor(WINNER);
    // The point of the change: the row is self-describing instead of relying
    // on its id being parsed.
    expect(entry.tournamentId).toBe(TID);
    expect(entry.place).toBe(1);
  });

  it("records each finisher's own place, not a shared one", async () => {
    await finalize();
    expect(historyFor(WINNER).place).toBe(1);
    expect(historyFor(RUNNER_UP).place).toBe(2);
  });

  it("prices rebuys as money rather than storing the count", async () => {
    await finalize();
    // One rebuy at a buy-in of 20.
    expect(historyFor(WINNER)).toMatchObject({ buyin: 20, rebuy: 20, win: 60 });
    expect(historyFor(RUNNER_UP)).toMatchObject({ buyin: 20, rebuy: 0, win: 20 });
  });

  it("writes no history for a guest, who has no account", async () => {
    await finalize();
    const touched = writes.filter((w) => w.path.startsWith("stats/"));
    expect(touched.map((w) => w.path).sort()).toEqual(
      [`stats/${RUNNER_UP}`, `stats/${WINNER}`].sort(),
    );
  });

  it("keeps history off the public profile doc", async () => {
    await finalize();
    // The user docs seeded here still carry the legacy `tournaments` field, so
    // finalize both writes the row to `stats/{uid}` and clears the old field —
    // no write may ever put history rows back on `users/{uid}`.
    for (const w of writes.filter((x) => x.path.startsWith("users/"))) {
      expect(Array.isArray(w.data.tournaments)).toBe(false);
    }
    expect(historyFor(WINNER)).toBeDefined();
  });

  it("still names the guest in the standings", async () => {
    const res = await finalize();
    expect(res.body.results[2]).toMatchObject({ name: "Steve", uid: null, place: 3 });
  });

  it("never duplicates a row for the same tournament and player", async () => {
    // A stale copy of this tournament's row is already in the history (e.g. a
    // partially reversed restart). Finalizing must replace it, not append a
    // second one — otherwise finish → restart → finish doubles the winnings.
    docs.set(`stats/${WINNER}`, {
      tournaments: [
        { id: `${TID}:${WINNER}`, date: "2026-08-01", title: "Friday game", buyin: 20, rebuy: 0, win: 60 },
      ],
    });
    await finalize();
    const write = [...writes].reverse().find((w) => w.path === `stats/${WINNER}`);
    const rows = (write?.data.tournaments ?? []) as { id?: string }[];
    expect(rows.filter((r) => r.id === `${TID}:${WINNER}`)).toHaveLength(1);
  });

  it("refuses a second finalization", async () => {
    await finalize();
    docs.set(`tournaments/${TID}`, {
      ...(docs.get(`tournaments/${TID}`) as Record<string, unknown>),
      status: "finished",
    });
    const res = await finalize();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("ALREADY_FINALIZED");
  });

  it("refuses a non-organizer before writing anything", async () => {
    const res = await as(
      request(app)
        .post(`/tournaments/${TID}/finalize`)
        .send({ results: [{ uid: WINNER, place: 1, winnings: 0 }] }),
      WINNER,
    );
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe("manual entries stay distinguishable", () => {
  it("cannot claim a tournament or a place", async () => {
    const res = await as(
      request(app).post("/stats/entries").send({
        date: "2026-08-14",
        title: "Home game",
        buyin: 10,
        rebuy: 0,
        win: 25,
        tournamentId: "t-1",
        place: 1,
      }),
      WINNER,
    );
    expect(res.status).toBe(201);
    // Validation strips unknown keys, so a client cannot forge a result that
    // looks like it came from finalizing a tournament.
    expect(res.body.entry.tournamentId).toBeUndefined();
    expect(res.body.entry.place).toBeUndefined();
  });
});
