import { defineConfig } from "vitest/config";

/**
 * The default run covers everything that needs no emulator, so `npm test` stays
 * fast and works offline.
 *
 * The security-rules tests are excluded here because they need the Firestore
 * emulator running; `npm run test:rules` starts one around them.
 */
export default defineConfig({
  test: {
    exclude: ["node_modules/**", "lib/**", "test/rules/**"],
  },
});
