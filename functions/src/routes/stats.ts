import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import { statsEntrySchema } from "../validation/schemas";
import { addEntry, deleteEntry, getStats } from "../services/stats";

export const statsRouter = Router();
statsRouter.use(requireAuth);

statsRouter.get("/me", async (req: AuthedRequest, res) => {
  res.json(await getStats(uidOf(req)));
});

statsRouter.post("/entries", async (req: AuthedRequest, res) => {
  const body = statsEntrySchema.parse(req.body);
  res.status(201).json({ entry: await addEntry(uidOf(req), body) });
});

statsRouter.delete("/entries/:entryId", async (req: AuthedRequest, res) => {
  // Entries are always the caller's own — the uid comes from the token, so one
  // user can never delete another's history.
  await deleteEntry(uidOf(req), req.params.entryId);
  res.status(204).send();
});
