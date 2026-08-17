import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app";

initializeApp();

/**
 * The whole REST API behind one HTTPS function.
 *
 * The region is pinned explicitly: both clients hardcode a base URL, and
 * letting it drift to a different default would silently break them.
 *
 * No `cors` option is passed on purpose — CORS is handled by the allowlist in
 * app.ts, which is the single implementation. Note that the emulator turns on
 * firebase-functions' own permissive CORS wrapper regardless, so locally every
 * origin appears to be accepted; the allowlist only actually restricts once
 * deployed. Passing `cors: false` would silence the wrapper but also make it
 * answer preflights with no headers at all, blocking even allowed origins.
 */
export const api = onRequest({ region: "us-central1" }, createApp());
