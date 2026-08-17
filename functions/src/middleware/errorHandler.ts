import type { NextFunction, Request, Response } from "express";
import { logger } from "firebase-functions";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors";

/** Unmatched route — mounted after all routers, before the error handler. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `No route for ${req.method} ${req.path}.`,
    },
  });
}

/**
 * The single place a response body is produced for a failure. Express 5
 * forwards rejected async handlers here automatically, so routes can just
 * throw. Unexpected errors are logged in full but never echoed to the client.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ApiError) {
    res.status(err.status).json(err.toJSON());
    return;
  }

  if (err instanceof ZodError) {
    const first = err.issues[0];
    const path = first?.path.join(".");
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: path ? `${path}: ${first.message}` : (first?.message ?? "Invalid request body."),
      },
    });
    return;
  }

  logger.error("Unhandled API error", err);
  res.status(500).json({
    error: {
      code: "INTERNAL",
      message: "Something went wrong. Please try again.",
    },
  });
}
