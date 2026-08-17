import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Firestore } from "firebase-admin/firestore";

/**
 * Resolved lazily so that importing a route or service does not require an
 * initialized Firebase app — tests stub this without booting the Admin SDK.
 */
export const db = (): Firestore => getFirestore();

export { FieldValue, Timestamp };

export const TOURNAMENTS = "tournaments";
export const USERS = "users";
export const ROSTERS = "rosters";
export const GROUPS = "groups";

/** Firestore hands back Timestamps, numbers or strings depending on the writer. */
export function toIsoDate(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

/** The `yyyy-MM-dd` string shape the stats entries have always used. */
export function toStatsDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
