import { Router } from "express";
import { requireAuth, uidOf, type AuthedRequest } from "../middleware/requireAuth";
import {
  addGuestSchema,
  createGroupSchema,
  inviteSchema,
  updateGroupSchema,
} from "../validation/schemas";
import {
  acceptInvite,
  addGuest,
  createGroup,
  declineInvite,
  deleteGroup,
  getGroup,
  inviteToGroup,
  listGroups,
  removeGuest,
  removeMember,
  renameGroup,
} from "../services/groups";

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

groupsRouter.get("/", async (req: AuthedRequest, res) => {
  res.json({ groups: await listGroups(uidOf(req)) });
});

groupsRouter.post("/", async (req: AuthedRequest, res) => {
  const { name } = createGroupSchema.parse(req.body);
  res.status(201).json({ group: await createGroup(uidOf(req), name) });
});

groupsRouter.get("/:id", async (req: AuthedRequest, res) => {
  res.json({ group: await getGroup(req.params.id, uidOf(req)) });
});

groupsRouter.put("/:id", async (req: AuthedRequest, res) => {
  const { name } = updateGroupSchema.parse(req.body);
  res.json({ group: await renameGroup(req.params.id, uidOf(req), name) });
});

groupsRouter.delete("/:id", async (req: AuthedRequest, res) => {
  await deleteGroup(req.params.id, uidOf(req));
  res.status(204).send();
});

groupsRouter.post("/:id/invites", async (req: AuthedRequest, res) => {
  const { uid: targetUid } = inviteSchema.parse(req.body);
  res.status(201).json({ group: await inviteToGroup(req.params.id, uidOf(req), targetUid) });
});

groupsRouter.post("/:id/invites/accept", async (req: AuthedRequest, res) => {
  res.json({ group: await acceptInvite(req.params.id, uidOf(req)) });
});

groupsRouter.post("/:id/invites/decline", async (req: AuthedRequest, res) => {
  await declineInvite(req.params.id, uidOf(req));
  res.status(204).send();
});

groupsRouter.delete("/:id/members/:memberUid", async (req: AuthedRequest, res) => {
  res.json({ group: await removeMember(req.params.id, uidOf(req), req.params.memberUid) });
});

groupsRouter.post("/:id/guests", async (req: AuthedRequest, res) => {
  const { name } = addGuestSchema.parse(req.body);
  res.status(201).json({ group: await addGuest(req.params.id, uidOf(req), name) });
});

groupsRouter.delete("/:id/guests/:guestId", async (req: AuthedRequest, res) => {
  res.json({ group: await removeGuest(req.params.id, uidOf(req), req.params.guestId) });
});
