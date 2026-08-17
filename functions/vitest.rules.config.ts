import { defineConfig } from "vitest/config";

/** Only the security-rules tests; they need the Firestore emulator running. */
export default defineConfig({
  test: {
    include: ["test/rules/**/*.test.ts"],
    // The emulator is shared state, so these must not run concurrently.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
