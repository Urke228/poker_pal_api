/**
 * Wire shapes returned by the API.
 *
 * These deliberately preserve the historical Firestore field names, quirks and
 * all — `buyIn` on a tournament but `buyin` on a stats entry, `allowAddons`
 * with a lowercase "d" but `addOns` on a roster. Both clients already read and
 * write those names; renaming them here would silently break stored data.
 */

export const PAYOUT_STRUCTURES = [
  "standard",
  "top-heavy",
  "flat",
  "winner-takes-all",
  "manual",
] as const;
export type PayoutStructure = (typeof PAYOUT_STRUCTURES)[number];

/** Absent status means `open` — every tournament created before this field existed. */
export type TournamentStatus = "open" | "finished";

export interface TournamentResult {
  /** Set for registered players; null for guests. */
  uid: string | null;
  /** Display name at the time of finalization. */
  name: string;
  place: number;
  winnings: number;
}

export interface Tournament {
  id: string;
  name: string;
  /** ISO 8601. Stored as a Firestore Timestamp. */
  dateTime: string | null;
  buyIn: number;
  playerLimit: number;
  payoutStructure: PayoutStructure;
  /** Percentages 0..100, present only when payoutStructure is "manual". */
  manualPayouts?: number[];
  isPublic: boolean;
  /** Present only for private tournaments. */
  inviteCode?: string;
  description: string;
  rules: string;
  allowRebuys: boolean;
  allowAddons: boolean;
  lateRegistration: boolean;
  createdBy: string;
  createdAt: string | null;
  participants: string[];
  status: TournamentStatus;
  results?: TournamentResult[];
  finalizedAt?: string | null;
}

/** A tournament plus the resolved data the clients used to fetch N+1 style. */
export interface TournamentDetail extends Tournament {
  organizerName: string;
  participantCount: number;
  guestCount: number;
}

export interface PlayerSummary {
  /**
   * Registered players are identified by uid; guests have no account and are
   * addressed by the roster-local id instead.
   */
  id: string;
  uid: string | null;
  name: string;
  isGuest: boolean;
  buyInPaid: boolean;
  rebuys: number;
  addOns: number;
}

export interface StatsEntry {
  id: string;
  /** `yyyy-MM-dd`. */
  date: string;
  title: string;
  buyin: number;
  /** A money amount of total rebuys, not a count. */
  rebuy: number;
  win: number;
}

export interface StatsOverview {
  played: number;
  totalBuyin: number;
  totalRebuy: number;
  totalCost: number;
  totalWin: number;
  profitLoss: number;
  winRate: number;
  roi: number;
  winRateChange: number | null;
  earningsChange: number | null;
  roiChange: number | null;
}

export interface StatsChartPoint {
  dateMs: number;
  cumulative: number;
  label: string;
}

export interface StatsResponse {
  overview: StatsOverview;
  entries: StatsEntry[];
  chart: StatsChartPoint[];
}

export interface GroupGuest {
  id: string;
  name: string;
}

export interface Group {
  id: string;
  name: string;
  ownerId: string;
  memberUids: string[];
  pendingInvites: string[];
  guests: GroupGuest[];
}
