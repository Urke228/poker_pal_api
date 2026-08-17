import type { NextFunction, Request, Response } from "express";
// Imported from the logger entry point, not the package root: importing
// `firebase-functions` itself pulls in the v1 compat layer, whose removed
// config() call crashes the function on load under v7.
import * as logger from "firebase-functions/logger";
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
 * Body-parser rejections (malformed JSON, an oversized payload, an unsupported
 * charset) arrive as `http-errors` objects rather than as anything this API
 * threw. They carry a 4xx `status` and `expose: true`, which is how a client
 * mistake is distinguished from an internal fault.
 *
 * Left unhandled these fall through to the 500 branch, which is both the wrong
 * status and a misleading one — the request was bad, not the server. The raw
 * payload hangs off `err.body` and is deliberately never read.
 */
interface HttpishError {
  status?: number;
  statusCode?: number;
  expose?: boolean;
  type?: string;
}

function asClientBodyError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as HttpishError;
  const status = e.status ?? e.statusCode;
  if (typeof status !== "number" || status < 400 || status >= 500) return null;
  if (e.expose !== true) return null;

  switch (e.type) {
    case "entity.parse.failed":
      return {
        status: 400,
        code: "MALFORMED_JSON",
        message: "The request body is not valid JSON.",
      };
    case "entity.too.large":
      return {
        status: 413,
        code: "PAYLOAD_TOO_LARGE",
        message: "The request body is too large.",
      };
    case "charset.unsupported":
    case "encoding.unsupported":
      return {
        status: 415,
        code: "UNSUPPORTED_ENCODING",
        message: "The request body uses an unsupported encoding.",
      };
    default:
      // Some other malformed-request rejection from the body parser.
      return {
        status,
        code: "BAD_REQUEST",
        message: "The request could not be read.",
      };
  }
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

  const bodyError = asClientBodyError(err);
  if (bodyError) {
    res.status(bodyError.status).json({
      error: { code: bodyError.code, message: bodyError.message },
    });
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
