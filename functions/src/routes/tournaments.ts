import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import {
  addPlayerSchema,
  createTournamentSchema,
  finalizeSchema,
  listTournamentsQuerySchema,
  updatePlayerSchema,
  updateTournamentSchema,
} from "../validation/schemas";
import {
  assertOrganizer,
  createTournament,
  deleteTournament,
  findByInviteCode,
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

tournamentsRouter.get("/", async (req: AuthedRequest, res) => {
  const { filter } = listTournamentsQuerySchema.parse(req.query);
  const tournaments = await listTournaments(uidOf(req), filter);
  // Resolved in one batched read so a list of N tournaments does not become
  // N separate user lookups in the client, which is what both apps used to do.
  const names = await resolveUsernames(tournaments.map((t) => t.createdBy));
  res.json({
    tournaments: tournaments.map((t) => ({
      ...t,
      organizerName: names.get(t.createdBy) ?? "Player",
    })),
  });
});

/** Resolve a private tournament's invite code without joining it. */
tournamentsRouter.get("/by-code/:code", async (req: AuthedRequest, res) => {
  const found = await findByInviteCode(req.params.code);
  if (!found) throw notFound("That invite code");
  res.json({ tournament: found });
});

tournamentsRouter.post("/", async (req: AuthedRequest, res) => {
  const body = createTournamentSchema.parse(req.body);
  const created = await createTournament(uidOf(req), body);
  res.status(201).json({ tournament: created });
});

tournamentsRouter.get("/:id", async (req: AuthedRequest, res) => {
  const t = mapTournament(await getTournamentOrThrow(req.params.id));
  const players = await listPlayers(t);
  const detail = await toDetail(t, players.filter((p) => p.isGuest).length);
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
  res.json({ tournament: await joinTournament(req.params.id, uidOf(req)) });
});

tournamentsRouter.post("/:id/leave", async (req: AuthedRequest, res) => {
  res.json({ tournament: await leaveTournament(req.params.id, uidOf(req)) });
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
