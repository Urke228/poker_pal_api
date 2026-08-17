import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import { createApp } from "./app";

initializeApp();

/**
 * The whole REST API behind one HTTPS function.
 *
 * The region is pinned explicitly: both clients hardcode a base URL, and
 * letting it drift to a different default would silently break them.
 */
export const api = onRequest({ region: "us-central1" }, createApp());
