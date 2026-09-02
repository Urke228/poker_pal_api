/**
 * One-time backfill: moves the private results history off the public profile.
 *
 * For every `users/{uid}` doc that still carries the legacy `tournaments`
 * array, copies it to `stats/{uid}.tournaments` (unless the stats doc already
 * has rows — the API migrates on write, so it may have run first; the stats
 * doc then wins) and deletes the legacy field from the user doc.
 *
 * Run once against production after deploying the functions + rules:
 *
 *   cd functions
 *   node scripts/migrate-history.js                # against the emulator, or
 *   set GOOGLE_APPLICATION_CREDENTIALS=<key.json>  # a service-account key
 *   node scripts/migrate-history.js --project pokerpal-a1451
 *
 * Idempotent: a second run finds nothing left to move.
 */
const admin = require("firebase-admin");

const projectFlag = process.argv.indexOf("--project");
const projectId = projectFlag !== -1 ? process.argv[projectFlag + 1] : undefined;

admin.initializeApp(projectId ? { projectId } : undefined);
const db = admin.firestore();

async function main() {
  const users = await db.collection("users").get();
  let moved = 0;
  let skipped = 0;

  for (const userSnap of users.docs) {
    const legacy = userSnap.data().tournaments;
    if (!Array.isArray(legacy)) {
      skipped++;
      continue;
    }

    const statsRef = db.collection("stats").doc(userSnap.id);
    await db.runTransaction(async (tx) => {
      const statsSnap = await tx.get(statsRef);
      const existing = statsSnap.exists ? statsSnap.data().tournaments : undefined;
      // The API may already have migrated this user (it does so on every stats
      // write); if so the stats doc is the newer truth — only clear the legacy.
      if (!Array.isArray(existing)) {
        tx.set(statsRef, { tournaments: legacy }, { merge: true });
      }
      tx.update(userSnap.ref, {
        tournaments: admin.firestore.FieldValue.delete(),
      });
    });
    moved++;
    console.log(`moved ${legacy.length} row(s) for ${userSnap.id}`);
  }

  console.log(`Done. ${moved} user(s) migrated, ${skipped} already clean.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
