import { initializeApp } from "firebase-admin/app";
import { onRequest } from "firebase-functions/v2/https";
import cors from "cors";
import express from "express";
import { requireAuth, type AuthedRequest } from "./auth";

initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Template for auth-gated, server-authoritative endpoints (payout finalization,
// tournament lifecycle transitions, etc.) — add routes here as they're needed.
app.get("/me", requireAuth, (req: AuthedRequest, res) => {
  res.json({ uid: req.uid });
});

export const api = onRequest({ cors: true }, app);
