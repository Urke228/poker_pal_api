import type { NextFunction, Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { unauthenticated } from "../lib/errors";

export interface AuthedRequest extends Request {
  uid?: string;
  email?: string | null;
  /**
   * Express 5 types route params as `string | string[]` to allow repeats.
   * None of our routes declare a repeating param, and annotating a handler
   * with this interface opts out of the per-path inference, so narrow it here
   * rather than unwrapping an array at every call site.
   */
  params: Record<string, string>;
}

/**
 * Verifies the `Authorization: Bearer <idToken>` header both clients send.
 *
 * The decoded uid is the ONLY identity the rest of the API trusts — request
 * bodies never get to declare who they are (no client-supplied `createdBy`,
 * `ownerId`, or `userId`).
 */
export async function requireAuth(
  req: AuthedRequest,
  _res: Response,
  next: NextFunction,
) {
  const header = req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) {
    next(unauthenticated("Missing Authorization header."));
    return;
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    req.uid = decoded.uid;
    req.email = decoded.email ?? null;
    next();
  } catch {
    next(unauthenticated("Your session has expired. Sign in again."));
  }
}

/** Narrows `req.uid` for handlers mounted behind requireAuth. */
export function uidOf(req: AuthedRequest): string {
  if (!req.uid) throw unauthenticated();
  return req.uid;
}
