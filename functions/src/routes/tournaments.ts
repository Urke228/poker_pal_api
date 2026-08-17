import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import {
  addPlayerSchema,
  createTournamentSchema,
  finalizeSchema,
  joinTournamentSchema,
  listTournamentsQuerySchema,
  updatePlayerSchema,
  updateTournamentSchema,
} from "../validation/schemas";
import {
  assertCanView,
  assertOrganizer,
  createTournament,
  deleteTournament,
  findByInviteCode,
  forViewer,
  getTournamentOrThrow,
  joinTournament,
  leaveTournament,
  listTournaments,
  mapTournament,
  resolveUsernames,
  toDetail,
  updateTournament,
} from "../services/tournaments";
import {
  addPlayer,
  listPlayers,
  removePlayer,
  updatePlayer,
} from "../services/participants";
import { finalizeTournament } from "../services/finalize";
import { notFound } from "../lib/errors";

export const tournamentsRouter = Router();
tournamentsRouter.use(requireAuth);

/**
 * The invite code for a private tournament, when the caller is allowed to send
 * one. It travels in a header rather than the query string so it stays out of
 * URLs, server logs, browser history and referrers.
 */
function tournamentCode(req: AuthedRequest): string | undefined {
  const header = req.header("X-Tournament-Code");
  return header && header.trim().length > 0 ? header.trim() : undefined;
}

tournamentsRouter.get("/", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const { filter } = listTournamentsQuerySchema.parse(req.query);
  const tournaments = await listTournaments(uid, filter);
  // Resolved in one batched read so a list of N tournaments does not become
  // N separate user lookups in the client, which is what both apps used to do.
  const names = await resolveUsernames(tournaments.map((t) => t.createdBy));
  res.json({
    tournaments: tournaments.map((t) => ({
      ...forViewer(t, uid),
      organizerName: names.get(t.createdBy) ?? "Player",
    })),
  });
});

/**
 * Resolve an invite code to the tournament it opens, without joining it.
 *
 * Holding the code is the whole authorization here — that is what a private
 * tournament's code is for. The response still omits the code itself, since the
 * caller already has it.
 */
tournamentsRouter.get("/by-code/:code", async (req: AuthedRequest, res) => {
  const found = await findByInviteCode(req.params.code);
  if (!found) throw notFound("That invite code");
  res.json({ tournament: forViewer(found, uidOf(req)) });
});

tournamentsRouter.post("/", async (req: AuthedRequest, res) => {
  const body = createTournamentSchema.parse(req.body);
  const created = await createTournament(uidOf(req), body);
  res.status(201).json({ tournament: created });
});

tournamentsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  assertCanView(t, uid, tournamentCode(req));
  const players = await listPlayers(t);
  const detail = await toDetail(forViewer(t, uid), players.filter((p) => p.isGuest).length);
  res.json({ tournament: detail, players });
});

tournamentsRouter.put("/:id", async (req: AuthedRequest, res) => {
  const body = updateTournamentSchema.parse(req.body);
  res.json({ tournament: await updateTournament(req.params.id, uidOf(req), body) });
});

tournamentsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  await deleteTournament(req.params.id, uidOf(req));
  res.status(204).send();
});

tournamentsRouter.post("/:id/join", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  const { inviteCode } = joinTournamentSchema.parse(req.body ?? {});
  const joined = await joinTournament(req.params.id, uid, inviteCode);
  res.json({ tournament: forViewer(joined, uid) });
});

tournamentsRouter.post("/:id/leave", async (req: AuthedRequest, res) => {
  const uid = uidOf(req);
  res.json({ tournament: forViewer(await leaveTournament(req.params.id, uid), uid) });
});

tournamentsRouter.post("/:id/finalize", async (req: AuthedRequest, res) => {
  const { results } = finalizeSchema.parse(req.body);
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  assertOrganizer(t, uidOf(req));
  const players = await listPlayers(t);
  const stored = await finalizeTournament(t, players, results);
  res.json({ status: "finished", results: stored });
});

/* ── participants ─────────────────────────────────────────────────────── */

tournamentsRouter.get("/:id/players", async (req: AuthedRequest, res) => {
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  // Same rule as the tournament itself: the player list carries names and
  // payment state, so it must not be the way round a private tournament.
  assertCanView(t, uidOf(req), tournamentCode(req));
  res.json({ players: await listPlayers(t) });
});

tournamentsRouter.post("/:id/players", async (req: AuthedRequest, res) => {
  const body = addPlayerSchema.parse(req.body);
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  assertOrganizer(t, uidOf(req));
  res.status(201).json({ players: await addPlayer(t, body) });
});

tournamentsRouter.put("/:id/players/:playerId", async (req: AuthedRequest, res) => {
  const body = updatePlayerSchema.parse(req.body);
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  assertOrganizer(t, uidOf(req));
  res.json({ players: await updatePlayer(t, req.params.playerId, body) });
});

tournamentsRouter.delete("/:id/players/:playerId", async (req: AuthedRequest, res) => {
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  assertOrganizer(t, uidOf(req));
  res.json({ players: await removePlayer(t, req.params.playerId) });
});
