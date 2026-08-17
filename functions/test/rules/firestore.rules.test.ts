import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  where,
} from "firebase/firestore";

/**
 * Exercises firestore.rules against the emulator.
 *
 * These cover the direct-client path only — the REST API uses the Admin SDK,
 * which ignores rules entirely. What is being proved here is that a client
 * holding nothing but a Firebase session cannot read a private tournament or
 * enumerate the collection.
 *
 * Run with:  npm run test:rules   (starts the Firestore emulator around it)
 */

const ORGANIZER = "organizer-uid";
const PARTICIPANT = "participant-uid";
const STRANGER = "stranger-uid";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "pokerpal-rules-test",
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../../firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  // Seeded with rules disabled so the fixtures themselves are not under test.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "tournaments/public-1"), {
      name: "Open game",
      isPublic: true,
      createdBy: ORGANIZER,
      participants: [PARTICIPANT],
    });
    await setDoc(doc(db, "tournaments/private-1"), {
      name: "Secret game",
      isPublic: false,
      inviteCode: "ABC123",
      createdBy: ORGANIZER,
      participants: [PARTICIPANT],
    });
    await setDoc(doc(db, "timers/private-1"), {
      createdBy: ORGANIZER,
      tournamentName: "Secret game",
      isRunning: true,
    });
  });
});

const asUser = (uid: string) => env.authenticatedContext(uid).firestore();
const asAnon = () => env.unauthenticatedContext().firestore();

describe("tournaments — reading a single document", () => {
  it("lets any signed-in user read a public tournament", async () => {
    await assertSucceeds(getDoc(doc(asUser(STRANGER), "tournaments/public-1")));
  });

  it("lets the organizer read their private tournament", async () => {
    await assertSucceeds(getDoc(doc(asUser(ORGANIZER), "tournaments/private-1")));
  });

  it("lets a participant read the private tournament they are in", async () => {
    await assertSucceeds(getDoc(doc(asUser(PARTICIPANT), "tournaments/private-1")));
  });

  it("refuses an unrelated user", async () => {
    await assertFails(getDoc(doc(asUser(STRANGER), "tournaments/private-1")));
  });

  it("refuses an unauthenticated reader outright", async () => {
    await assertFails(getDoc(doc(asAnon(), "tournaments/public-1")));
    await assertFails(getDoc(doc(asAnon(), "tournaments/private-1")));
  });

  it("allows a get on a document that does not exist", async () => {
    // The clock screen relies on this to tell "missing" from "forbidden".
    await assertSucceeds(getDoc(doc(asUser(STRANGER), "tournaments/no-such-id")));
  });

  it("holding the invite code does not help a direct read", async () => {
    // Code-based access is the API's job; a rule cannot verify a secret the
    // client would have to hand it.
    await assertFails(getDoc(doc(asUser(STRANGER), "tournaments/private-1")));
  });
});

describe("tournaments — enumeration is impossible", () => {
  it("refuses an unfiltered listing", async () => {
    await assertFails(getDocs(collection(asUser(STRANGER), "tournaments")));
  });

  it("refuses a listing even to the organizer", async () => {
    // Listing goes through GET /tournaments, so no client needs this.
    await assertFails(getDocs(collection(asUser(ORGANIZER), "tournaments")));
  });

  it("refuses a query filtered to public tournaments", async () => {
    await assertFails(
      getDocs(
        query(collection(asUser(STRANGER), "tournaments"), where("isPublic", "==", true)),
      ),
    );
  });

  it("refuses a query that would surface private tournaments", async () => {
    await assertFails(
      getDocs(
        query(
          collection(asUser(STRANGER), "tournaments"),
          where("isPublic", "==", false),
        ),
      ),
    );
  });
});

describe("tournaments — writes are closed to clients", () => {
  it("refuses a write from the organizer", async () => {
    await assertFails(
      setDoc(doc(asUser(ORGANIZER), "tournaments/private-1"), { name: "Renamed" }),
    );
  });

  it("refuses a create", async () => {
    await assertFails(
      setDoc(doc(asUser(STRANGER), "tournaments/new-1"), {
        name: "Mine now",
        createdBy: STRANGER,
        isPublic: true,
        participants: [],
      }),
    );
  });
});

describe("the clock is unaffected", () => {
  it("still lets a signed-in user read a timer document", async () => {
    // The TV display reads timers/{id} directly and must keep working. Note it
    // never reads the tournaments collection at all.
    await assertSucceeds(getDoc(doc(asUser(STRANGER), "timers/private-1")));
  });

  it("still lets an organizer list their own clocks", async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(asUser(ORGANIZER), "timers"),
          where("createdBy", "==", ORGANIZER),
        ),
      ),
    );
  });

  it("still refuses an unauthenticated reader", async () => {
    await assertFails(getDoc(doc(asAnon(), "timers/private-1")));
  });
});
