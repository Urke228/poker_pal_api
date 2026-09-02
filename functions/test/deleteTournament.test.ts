import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * Deleting a tournament must also delete its side-car documents — the roster,
 * seating chart, timer and display-control doc all live under the tournament's
 * own id. Before the cascade they were orphaned forever, seating charts full
 * of player names included.
 */

const verifyIdToken = vi.fn();
vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({ verifyIdToken }) }));

const docs = new Map<string, Record<string, unknown>>();
const deletes: string[] = [];

vi.mock("firebase-admin/firestore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("firebase-admin/firestore")>();
  const docHandle = (collection: string, id: string) => ({
    id,
    path: `${collection}/${id}`,
    get: async () => {
      const data = docs.get(`${collection}/${id}`);
      return {
        exists: data !== undefined,
        id,
        data: () => data,
        ref: docHandle(collection, id),
      };
    },
    delete: async () => {
      deletes.push(`${collection}/${id}`);
      docs.delete(`${collection}/${id}`);
    },
  });
  return {
    ...actual,
    getFirestore: () => ({
      collection: (collection: string) => ({
        doc: (id: string) => docHandle(collection, id),
      }),
      batch: () => {
        const staged: { path: string }[] = [];
        return {
          delete: (ref: { path: string }) => staged.push(ref),
          commit: async () => {
            for (const ref of staged) {
              deletes.push(ref.path);
              docs.delete(ref.path);
            }
          },
        };
      },
    }),
  };
});

const { createApp } = await import("../src/app");
const app = createApp();

const ORGANIZER = "organizer-uid";
const STRANGER = "stranger-uid";
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
  deletes.length = 0;

  docs.set(`tournaments/${TID}`, {
    name: "Friday game",
    buyIn: 20,
    playerLimit: 8,
    payoutStructure: "standard",
    isPublic: true,
    createdBy: ORGANIZER,
    participants: [],
    status: "open",
  });
  docs.set(`rosters/${TID}`, { ownerId: ORGANIZER, players: [] });
  docs.set(`seatings/${TID}`, { tables: [{ seats: ["Ada"] }] });
  docs.set(`timers/${TID}`, { createdBy: ORGANIZER, isRunning: false });
  docs.set(`displays/${TID}`, { createdBy: ORGANIZER, tab: "clock" });
});

describe("DELETE /tournaments/:id", () => {
  it("deletes the tournament and every side-car document", async () => {
    const res = await as(request(app).delete(`/tournaments/${TID}`), ORGANIZER);
    expect(res.status).toBe(204);
    expect([...deletes].sort()).toEqual(
      [
        `tournaments/${TID}`,
        `rosters/${TID}`,
        `seatings/${TID}`,
        `timers/${TID}`,
        `displays/${TID}`,
      ].sort(),
    );
  });

  it("refuses a non-organizer and deletes nothing", async () => {
    const res = await as(request(app).delete(`/tournaments/${TID}`), STRANGER);
    expect(res.status).toBe(403);
    expect(deletes).toHaveLength(0);
  });
});
