import { z } from "zod";
import { PAYOUT_STRUCTURES } from "../types/models";

const name = z
  .string()
  .trim()
  .min(1, "Name is required.")
  .max(120, "Name must be 120 characters or fewer.");

const buyIn = z
  .number({ message: "Buy-in must be a number." })
  .nonnegative("Buy-in must be greater than or equal to zero.")
  .finite();

const playerLimit = z
  .number({ message: "Player limit must be a number." })
  .int("Player limit must be a whole number.")
  .min(2, "Player limit must be at least 2.")
  .max(100, "Player limit must be 100 or fewer.");

const dateTime = z
  .string()
  .refine((v) => !Number.isNaN(new Date(v).getTime()), "Date is not a valid date.");

const manualPayouts = z
  .array(z.number().min(0, "Payout percentages cannot be negative.").max(100, "A payout percentage cannot exceed 100."))
  .min(1, "Provide at least one payout percentage.");

/**
 * `manual` is the only structure that carries explicit percentages; for every
 * other structure the field must be absent so it can be deleted from the doc.
 */
function requireManualPayouts(
  v: { payoutStructure: string; manualPayouts?: number[] },
  ctx: z.RefinementCtx,
) {
  if (v.payoutStructure === "manual" && (!v.manualPayouts || v.manualPayouts.length === 0)) {
    ctx.addIssue({
      code: "custom",
      path: ["manualPayouts"],
      message: "Manual payouts require at least one percentage.",
    });
  }
}

const tournamentFields = {
  name,
  dateTime,
  buyIn,
  playerLimit,
  payoutStructure: z.enum(PAYOUT_STRUCTURES),
  manualPayouts: manualPayouts.optional(),
  isPublic: z.boolean(),
  inviteCode: z.string().trim().max(32).optional(),
  description: z.string().max(4000).default(""),
  rules: z.string().max(4000).default(""),
  allowRebuys: z.boolean().default(false),
  allowAddons: z.boolean().default(false),
  lateRegistration: z.boolean().default(false),
};

export const createTournamentSchema = z
  .object({
    ...tournamentFields,
    /** Seeds `participants` at creation; the organizer comes from the token. */
    organizerIsPlaying: z.boolean().default(false),
    groupMemberUids: z.array(z.string()).default([]),
  })
  .superRefine(requireManualPayouts);

export const updateTournamentSchema = z
  .object(tournamentFields)
  .superRefine(requireManualPayouts);

export const listTournamentsQuerySchema = z.object({
  filter: z.enum(["mine", "registered", "public", "all"]).default("all"),
});

/**
 * Joining a private tournament requires its invite code. It travels in the body
 * rather than the query string so it stays out of URLs, logs and referrers.
 */
export const joinTournamentSchema = z.object({
  inviteCode: z.string().trim().min(1).max(32).optional(),
});

export const addPlayerSchema = z
  .object({
    uid: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1, "Player name is required.").max(80).optional(),
  })
  .refine((v) => Boolean(v.uid) !== Boolean(v.name), {
    message: "Provide either a uid (registered player) or a name (guest), not both.",
  });

/**
 * Rebuys and add-ons are counts, and they multiply into the prize pool that
 * finalization checks winnings against. Left unbounded, an implausible count
 * inflates that ceiling until it stops constraining anything, so cap them at a
 * number no real tournament reaches.
 */
const MAX_REBUYS_PER_PLAYER = 100;

export const updatePlayerSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  buyInPaid: z.boolean().optional(),
  rebuys: z
    .number()
    .int("Rebuys must be a whole number.")
    .min(0, "Rebuys cannot be negative.")
    .max(MAX_REBUYS_PER_PLAYER, `Rebuys must be ${MAX_REBUYS_PER_PLAYER} or fewer.`)
    .optional(),
  addOns: z
    .number()
    .int("Add-ons must be a whole number.")
    .min(0, "Add-ons cannot be negative.")
    .max(MAX_REBUYS_PER_PLAYER, `Add-ons must be ${MAX_REBUYS_PER_PLAYER} or fewer.`)
    .optional(),
});

export const finalizeSchema = z.object({
  results: z
    .array(
      z
        .object({
          uid: z.string().trim().min(1).optional(),
          guestName: z.string().trim().min(1).optional(),
          place: z.number().int().min(1, "Places start at 1."),
          winnings: z.number().min(0, "Winnings cannot be negative.").finite(),
        })
        .refine((v) => Boolean(v.uid) !== Boolean(v.guestName), {
          message: "Each result needs either a uid or a guestName, not both.",
        }),
    )
    .min(1, "Provide at least one result."),
});

export const statsEntrySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in yyyy-MM-dd format."),
  title: z.string().trim().min(1, "Title is required.").max(120),
  buyin: z.number().min(0, "Buy-in cannot be negative.").finite(),
  rebuy: z.number().min(0, "Rebuy cannot be negative.").finite().default(0),
  win: z.number().min(0, "Winnings cannot be negative.").finite(),
});

/**
 * The username is optional — when it is absent the API falls back to the local
 * part of the caller's email. The cap matters because this value is written
 * straight into the profile document.
 */
export const ensureProfileSchema = z.object({
  username: z
    .string()
    .trim()
    .min(1, "Username cannot be empty.")
    .max(60, "Username must be 60 characters or fewer.")
    .optional(),
});

export const createGroupSchema = z.object({ name });
export const updateGroupSchema = z.object({ name });
export const inviteSchema = z.object({
  uid: z.string().trim().min(1, "A user id is required."),
});
export const addGuestSchema = z.object({
  name: z.string().trim().min(1, "Guest name is required.").max(80),
});
