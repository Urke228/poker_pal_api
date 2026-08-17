import cors from "cors";
import express from "express";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { requireAuth, uidOf, type AuthedRequest } from "./middleware/requireAuth";
import { statsRouter } from "./routes/stats";
import { tournamentsRouter } from "./routes/tournaments";
import { usersRouter } from "./routes/users";

/**
 * Only these origins may call the API from a browser. The Flutter client is
 * not subject to CORS, but it uses the same routes, so there is exactly one
 * interface to reason about.
 */
const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175",
  "https://pokerpal-a1451.web.app",
  "https://pokerpal-a1451.firebaseapp.com",
];

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers (Flutter, curl) send no Origin.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed.`));
      },
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Kept at the top level because both clients call it right after sign-in.
  app.get("/me", requireAuth, async (req: AuthedRequest, res) => {
    res.json({ uid: uidOf(req), email: req.email ?? null });
  });

  app.use("/tournaments", tournamentsRouter);
  app.use("/stats", statsRouter);
  app.use("/users", usersRouter);

  app.use(notFoundHandler);
  // Express 5 forwards rejected async handlers here, so routes can just throw.
  app.use(errorHandler);

  return app;
}
