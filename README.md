# PokerPal API

The REST service behind PokerPal, shared by both clients.

```
Flutter Android ─┐
                 ├── HTTPS / REST / JSON → Firebase Cloud Functions → Firestore
React Web ───────┘                         (Express + TypeScript,
                                            Firebase Admin SDK)

Firebase Authentication supplies ID tokens used by both clients.
```

## Contents

- [Architecture](#architecture)
- [Authentication](#authentication)
- [Errors](#errors)
- [Endpoints](#endpoints)
- [What still talks to Firestore directly](#what-still-talks-to-firestore-directly)
- [Running it](#running-it)

## Architecture

Three repositories against one Firebase project (`pokerpal-a1451`):

| Repo | Role |
|---|---|
| [`poker_pal`](../poker_pal) | Flutter Android client — the full feature set |
| [`poker_pal_web`](../poker_pal_web) | React + Vite + TypeScript client — tournaments, clock display, statistics |
| `poker_pal_api` | This service: Cloud Functions + Express + TypeScript, plus the Firestore security rules |

The whole API is one HTTPS function (`api`) pinned to `us-central1`, with an
Express app behind it:

```
src/
  index.ts                  # the onRequest wrapper
  app.ts                    # express app: CORS allowlist, routers, error handler
  middleware/
    requireAuth.ts          # verifies the Firebase ID token
    errorHandler.ts         # the one place a failure response is produced
  lib/
    errors.ts               # ApiError + helpers
    firestore.ts            # lazily-resolved db handle and conversions
  routes/                   # tournaments, groups, stats, users
  services/                 # the domain logic the routes call
  validation/schemas.ts     # zod schemas
  types/models.ts           # wire shapes
test/                       # vitest
```

**Firebase and Firestore stand in for the Tomcat + MySQL stack the assignment
originally suggested, with the instructor's approval.** Cloud Functions host the
Express application and Firestore is the database; the REST interface, the
validation, the authorization and the error handling are all implemented here in
the usual way.

### Why there is a server at all

Two things in this application cannot be done correctly from a client:

1. **Finalizing a tournament.** The security rules let a client write only its
   *own* `users/{uid}` document, so no client can record results into the other
   participants' histories. The Admin SDK can, and does it in one transaction:
   the standings, the status change and every finisher's statistics entry commit
   together or not at all.
2. **Joining a tournament.** The player-limit check and the participant append
   have to be atomic, or two people racing for the last seat can both take it. A
   client-side transaction can only approximate this.

Statistics are a third, softer case: the arithmetic used to exist twice, once in
each client, and could drift. There is now one implementation.

## Authentication

Both clients sign in with Firebase Authentication and send the resulting ID
token:

```
Authorization: Bearer <firebase-id-token>
```

`requireAuth` verifies it and attaches the decoded uid to the request. **That uid
is the only identity the API trusts.** A request body never gets to say who it
is — `createdBy`, `ownerId` and the owner of a statistics entry all come from the
token, so passing someone else's id changes nothing.

Every route requires authentication except `GET /health`.

## Errors

Every failure has the same shape:

```json
{
  "error": {
    "code": "INVALID_BUY_IN",
    "message": "Buy-in must be greater than or equal to zero."
  }
}
```

Branch on `code`; show `message`. Unexpected errors are logged server-side and
returned as a bare `500 INTERNAL` — internals are never echoed back.

| Status | When |
|---|---|
| 200 | OK |
| 201 | Created |
| 204 | Done, nothing to return (deletes) |
| 400 | Validation failed, or a domain rule was broken |
| 401 | Missing, malformed or expired token |
| 403 | Signed in, but not allowed (e.g. not the organizer) |
| 404 | No such tournament, group, user or route |
| 409 | State clash: tournament full, already joined, already finalized |
| 500 | Unhandled server error |

Common codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`,
`ALREADY_JOINED`, `TOURNAMENT_FULL`, `TOURNAMENT_FINISHED`, `ALREADY_FINALIZED`,
`INVALID_PLACEMENTS`, `INVALID_WINNINGS`, `UNKNOWN_PLAYER`, `DUPLICATE_PLAYER`,
`ALREADY_MEMBER`, `ALREADY_INVITED`, `NO_INVITE`, `OWNER_CANNOT_LEAVE`,
`INTERNAL`.

## Endpoints

### Health and identity

#### `GET /health`
Public. → `200 {"ok": true}`

#### `GET /me`
→ `200 {"uid": "...", "email": "..."}` · `401`

#### `GET /users/me`
Current user with profile fields.
→ `200 {"uid","email","username","photoURL","hasProfile"}` · `401`

#### `POST /users/ensure-profile`
Creates `users/{uid}` if missing; a no-op otherwise. Both clients call this after
sign-up and after a first Google sign-in, so a profile created on web is
identical to one created on mobile.

Body: `{"username": "Ada"}` (optional; falls back to the email's local part)
→ `201 {"created": true, "username": "Ada"}` · `200 {"created": false}` · `401`

#### `GET /users/:id`
→ `200 {"uid","username","photoURL"}` · `401` · `404`

---

### Tournaments

#### `GET /tournaments?filter=mine|registered|public|all`
`mine` = organized by the caller, `registered` = joined by the caller, `public` =
joinable (public, not the caller's own, not already joined), `all` = the union.
Sorted newest first. Organizer names are resolved server-side in one batched
read.

→ `200 {"tournaments": [Tournament & {organizerName}]}` · `400` (bad filter) · `401`

#### `POST /tournaments`
`createdBy` comes from the token. `organizerIsPlaying` and `groupMemberUids` seed
the participant list.

```json
{
  "name": "Friday game",
  "dateTime": "2026-09-04T19:00:00.000Z",
  "buyIn": 20,
  "playerLimit": 8,
  "payoutStructure": "standard",
  "isPublic": true,
  "description": "",
  "rules": "",
  "allowRebuys": true,
  "allowAddons": false,
  "lateRegistration": false,
  "organizerIsPlaying": true,
  "groupMemberUids": []
}
```

Validation: non-empty `name`; `buyIn >= 0`; `playerLimit` a whole number 2–100;
`payoutStructure` one of `standard`, `top-heavy`, `flat`, `winner-takes-all`,
`manual`; `manualPayouts` required for `manual`, each 0–100; `dateTime`
parseable.

→ `201 {"tournament": Tournament}` · `400` · `401`

#### `GET /tournaments/:id`
Returns the tournament with the organizer's name and the players list, so
clients do not need a lookup per participant.

→ `200 {"tournament": TournamentDetail, "players": [Player]}` · `401` · `404`

#### `PUT /tournaments/:id`
Organizer only. Same body as create, minus the seeding fields. `createdBy`,
`createdAt` and `participants` are never rewritten. Omitting `manualPayouts` or
`inviteCode` **deletes** them, which is how "not applicable" has always been
stored.

→ `200 {"tournament": Tournament}` · `400` · `401` · `403` · `404`

#### `DELETE /tournaments/:id`
Organizer only. → `204` · `401` · `403` · `404`

#### `GET /tournaments/by-code/:code`
Resolves an invite code without joining. → `200 {"tournament": Tournament}` · `401` · `404`

#### `POST /tournaments/:id/join`
Transactional: re-reads the tournament, checks the limit, appends the caller.

→ `200 {"tournament": Tournament}` · `401` · `404` ·
`409 ALREADY_JOINED | TOURNAMENT_FULL | TOURNAMENT_FINISHED`

#### `POST /tournaments/:id/leave`
→ `200 {"tournament": Tournament}` · `401` · `404` · `409 TOURNAMENT_FINISHED`

---

### Participants

A tournament's players live in two places: registered users in
`tournaments/{id}.participants`, and guests without an account in
`rosters/{tournamentId}.players`. These endpoints present them as one list.
Guests are addressed by a `guest:<name>` id, registered players by their uid.

#### `GET /tournaments/:id/players`
→ `200 {"players": [Player]}` · `401` · `404`

```json
{"id":"u2","uid":"u2","name":"Ada","isGuest":false,"buyInPaid":true,"rebuys":1,"addOns":0}
```

#### `POST /tournaments/:id/players`
Organizer only. Exactly one of `uid` (registered) or `name` (guest).

→ `201 {"players": [Player]}` · `400` · `401` · `403` · `404` ·
`409 ALREADY_JOINED | TOURNAMENT_FULL | DUPLICATE_PLAYER`

#### `PUT /tournaments/:id/players/:playerId`
Organizer only. Body: any of `name`, `buyInPaid`, `rebuys`, `addOns`.
→ `200 {"players": [Player]}` · `400` · `401` · `403` · `404`

#### `DELETE /tournaments/:id/players/:playerId`
Organizer only. Removes a participant or a guest depending on the id.
→ `200 {"players": [Player]}` · `401` · `403` · `404`

---

### Finalization

#### `POST /tournaments/:id/finalize`
Organizer only. The server-authoritative operation.

```json
{
  "results": [
    {"uid": "u1", "place": 1, "winnings": 100},
    {"uid": "u2", "place": 2, "winnings": 60},
    {"guestName": "Steve", "place": 3, "winnings": 0}
  ]
}
```

Checks, in order: the caller is the organizer; the tournament exists and is not
already finished; places form a contiguous 1..N ranking with no duplicates and no
gaps; winnings are non-negative and do not exceed the prize pool derived from the
roster; every `uid` is a participant and every `guestName` an existing guest.

Then, in one transaction: writes `status: "finished"`, `results` and
`finalizedAt`, and appends an entry to each registered finisher's
`users/{uid}.tournaments`. Guests get none — they have no account.

→ `200 {"status": "finished", "results": [TournamentResult]}` ·
`400 INVALID_PLACEMENTS | INVALID_WINNINGS | UNKNOWN_PLAYER` ·
`401` · `403` · `404` · `409 ALREADY_FINALIZED`

---

### Statistics

Computed server-side. Both clients render what they are given, so they cannot
disagree about a player's record.

```
cost(e)    = buyin + rebuy
totalCost  = Σ buyin + Σ rebuy
profitLoss = Σ win − totalCost
profitable = count(win > cost)      // strictly greater: breaking even is not a win
winRate    = played > 0 ? profitable / played × 100 : 0
roi        = totalCost > 0 ? profitLoss / totalCost × 100 : 0
```

The `…Change` figures compare against every entry except the last one **in array
order** — "what did the most recently added entry do to this number". Both
clients have always behaved this way; it is preserved deliberately, and pinned by
a test.

#### `GET /stats/me` · `GET /users/:id/stats`
→ `200 {"overview": StatsOverview, "entries": [StatsEntry], "chart": [StatsChartPoint]}` · `401` · `404`

```json
{
  "overview": {
    "played": 12, "totalBuyin": 240, "totalRebuy": 60, "totalCost": 300,
    "totalWin": 410, "profitLoss": 110, "winRate": 41.7, "roi": 36.7,
    "winRateChange": 2.4, "earningsChange": 80, "roiChange": 5.1
  },
  "entries": [
    {"id":"1756...","date":"2026-08-14","title":"Friday game","buyin":20,"rebuy":0,"win":80}
  ],
  "chart": [{"dateMs": 1786000000000, "cumulative": 60, "label": "Friday game"}]
}
```

Note the historical field names: `buyin` (lowercase "i"), `rebuy` (singular, a
money amount rather than a count) and `title`. A tournament, by contrast, uses
`buyIn` and `name`. These are the names in the stored documents and are kept as
they are.

#### `POST /stats/entries`
Appended in a transaction — both clients previously read the array and wrote it
back whole, which could silently drop a concurrent update.

Body: `{"date":"2026-08-14","title":"Friday game","buyin":20,"rebuy":0,"win":80}`
(`date` must be `yyyy-MM-dd`; amounts non-negative)

→ `201 {"entry": StatsEntry}` · `400` · `401`

#### `DELETE /stats/entries/:entryId`
Always the caller's own entry — the uid comes from the token, so one user can
never delete another's history. Legacy rows stored without an id are addressed as
`legacy:<index>`.

→ `204` · `401` · `404`

---

### Groups

A group is a reusable set of regulars: registered members, pending invites, and
guests without an account.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/groups` | Owned by, joined by, or inviting the caller |
| `POST` | `/groups` | `{"name": "Friday Regulars"}` → `201` |
| `GET` | `/groups/:id` | Owner, member or invitee only; others get `404` |
| `PUT` | `/groups/:id` | Rename. Owner only |
| `DELETE` | `/groups/:id` | Owner only → `204` |
| `POST` | `/groups/:id/invites` | `{"uid": "..."}`. Owner only → `201` |
| `POST` | `/groups/:id/invites/accept` | Invitee only. Transactional |
| `POST` | `/groups/:id/invites/decline` | Invitee only → `204` |
| `DELETE` | `/groups/:id/members/:memberUid` | Owner removes anyone; a member removes only themselves |
| `POST` | `/groups/:id/guests` | `{"name": "Steve"}`. Owner only → `201` |
| `DELETE` | `/groups/:id/guests/:guestId` | Owner only |

Group responses are `{"group": Group}`. Errors: `400`, `401`, `403`, `404`,
`409 ALREADY_MEMBER | ALREADY_INVITED | NO_INVITE | OWNER_CANNOT_LEAVE | DUPLICATE_GUEST`.

## What still talks to Firestore directly

Not everything belongs behind REST. These are deliberate:

- **The tournament clock (`timers`), in both clients.** The document is a timing
  anchor (`levelEndsAtMs`, `isRunning`, `pausedRemainingMs`) that clients roll
  forward locally. The organizer's phone controls it while a laptop or TV shows
  it, so a pause or a level change has to appear within a second. Polling would
  show a stale blind level.
- **The roster's payment tracking (`rosters`), on mobile.** A live per-player
  buy-in/rebuy/add-on tracker with frequent small writes. The API reads this
  collection for guests and the prize pool, but the tracker itself stays put.
- **Group reads, on mobile.** An invite should reach the invitee without them
  refreshing. Group *writes* are available over REST.
- **Profile and social writes.** Self-scoped, and the security rules already
  constrain them correctly.

Firestore rules were tightened once the clients stopped writing: `tournaments` is
now read-only to clients, and a user's `tournaments` array (their results
history) is API-only, so a player cannot edit their own record after the fact.

**The Admin SDK bypasses the security rules entirely.** The rules constrain only
the clients. What protects the data behind the API is the authorization each
endpoint performs for itself.

## Running it

```bash
cd functions
npm install
npm run build
npm test          # vitest
```

Development runs the Functions emulator while the Admin SDK talks to the real
Firestore and Auth, so there is no data to seed and tokens from either client
just work:

```bash
firebase emulators:start --only functions
curl http://127.0.0.1:5001/pokerpal-a1451/us-central1/api/health   # {"ok":true}
```

Point the clients at it:

```bash
# React — .env.local
VITE_API_BASE_URL=http://127.0.0.1:5001/pokerpal-a1451/us-central1/api

# Flutter — adb reverse makes 127.0.0.1 reach the development machine
adb reverse tcp:5001 tcp:5001
flutter run --dart-define=API_BASE_URL=http://127.0.0.1:5001/pokerpal-a1451/us-central1/api
```

Deploy:

```bash
firebase deploy --only functions,firestore:rules
```

The deployed base URL is
`https://us-central1-pokerpal-a1451.cloudfunctions.net/api`, which is what both
clients fall back to when nothing is configured.

### CORS

Browsers may call the API from `localhost:5173`–`5175` and from
`pokerpal-a1451.web.app` / `.firebaseapp.com`. Add new origins to
`ALLOWED_ORIGINS` in `src/app.ts`. Flutter is not subject to CORS but uses the
same routes.

### A version pin worth knowing about

`firebase-functions` is held at v6 and `firebase-admin` at v13. v7 requires
firebase-tools ≥ 15; the CLI in use is 14.3.1, whose emulator still injects
runtime configuration through the `functions.config()` API that v7 removed, which
kills the function on load. Upgrade the CLI first if you want to move these
forward. The reasoning is also recorded in `functions/package.json`.
