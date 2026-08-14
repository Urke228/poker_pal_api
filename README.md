# poker_pal_api

Backend for PokerPal: Firestore security rules + a REST API (Cloud Functions,
TypeScript/Express) for server-authoritative logic that the mobile app
([poker_pal](../poker_pal)) and web app ([poker_pal_web](../poker_pal_web))
share.

## Why this exists separately from direct Firestore access

Both clients read/write Firestore directly (gated by `firestore.rules`) for
real-time state — the blinds clock, live player lists, etc. That's the right
tool for real-time UI. This API is for the things direct client writes are
bad at:

- Server-authoritative business logic that shouldn't be duplicated in Dart
  and TypeScript (payout calculation, tournament lifecycle transitions).
- Anything needing a secret or third-party call (email, push notifications,
  payments).
- Aggregation/reporting across users that security rules can't safely express.
- Writes you don't want a client to be able to make directly.

## Structure

- `firestore.rules` — security rules, deployed with `firebase deploy --only firestore:rules`.
- `functions/` — the Cloud Functions app.
  - `src/index.ts` — Express app mounted as a single HTTPS function (`api`).
  - `src/auth.ts` — `requireAuth` middleware; verifies the Firebase ID token
    clients send as `Authorization: Bearer <idToken>`.

## Endpoints

- `GET /health` — liveness check, no auth.
- `GET /me` — auth-gated template endpoint; returns the caller's uid. Use
  this as the pattern for new endpoints (add the route, wrap with
  `requireAuth`, read `req.uid`).

## Local development

```bash
cd functions
npm install
npm run build:watch    # in one terminal
npm run serve          # in another — starts the Firestore + Functions emulators
```

## Deploy

```bash
firebase deploy --only firestore:rules,functions
```
