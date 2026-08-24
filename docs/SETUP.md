# PokerPal — bring-up on a new machine

Instructions for a coding agent (Copilot) setting up all three PokerPal repos from
scratch. Everything below is verified against the committed state of the repos.

One Firebase project backs all three: **`pokerpal-a1451`** (already set as the
default in every `.firebaserc` — do not run `firebase init`, it will overwrite
committed config).

## 0. Prerequisites

Install these first and confirm each version before touching the repos:

| Tool | Version | Why this version |
|---|---|---|
| Node.js | **20 LTS** | `functions/package.json` pins `"engines": { "node": "20" }` |
| firebase-tools | **14.3.1 exactly** | Do **not** install latest — see the warning below |
| Flutter SDK | 3.29+ (Dart `^3.7.2`) | `pubspec.yaml` environment constraint |
| Android Studio + SDK + JDK 17 | current | Android builds for the Flutter client |
| Git | any | — |

```powershell
node --version                       # must print v20.x
npm install -g firebase-tools@14.3.1
firebase --version                   # must print 14.3.1
flutter --version
flutter doctor                       # resolve anything it flags for Android
firebase login
```

> **Do not upgrade firebase-tools.** `poker_pal_api/functions/package.json` holds
> `firebase-functions` at v6 on purpose. v7 requires firebase-tools >= 15, while
> CLI 14.3.1 still injects runtime config through the `functions.config()` API
> that v7 removed — which kills the function on load in the emulator. If you
> upgrade one side without the other, the emulator will fail at startup.

## 1. Clone

```powershell
mkdir C:\dev\PokerPal
cd C:\dev\PokerPal
git clone https://github.com/Urke228/poker_pal.git
git clone https://github.com/Urke228/poker_pal_api.git
git clone https://github.com/Urke228/poker_pal_web.git
```

**Important — `poker_pal` lands on the wrong branch.** The repo's default branch
is `main`, but the current work is on `production-hardening`:

```powershell
cd poker_pal
git checkout production-hardening
cd ..
```

`poker_pal_api` and `poker_pal_web` are both on `master`, which is correct.

Keep all three side by side in one parent folder — the API README and the web
`.env.example` refer to each other by relative path (`../poker_pal_api`).

## 2. poker_pal_api (backend — start here, the clients need it)

```powershell
cd poker_pal_api\functions
npm install
npm run build          # compiles TypeScript into functions/lib (gitignored, expected)
npm test               # vitest — should pass
```

Run the emulator (leave this running in its own terminal):

```powershell
cd poker_pal_api
firebase emulators:start --only functions
```

It serves the API at:

```
http://127.0.0.1:5001/pokerpal-a1451/us-central1/api
```

No secrets or service-account keys are needed — the Admin SDK uses application
default credentials from `firebase login`.

## 3. poker_pal_web (React + Vite)

```powershell
cd poker_pal_web
npm install
copy .env.example .env.local
npm run dev
```

**The `.env.local` copy is mandatory.** It is gitignored, so a fresh clone has no
env file, and the app deliberately fails loudly at startup when
`VITE_API_BASE_URL` is missing. The committed `.env.example` already defaults to
the local emulator URL, so an unedited copy is correct for local development.
To run against the deployed backend instead, comment out the emulator line and
uncomment the `cloudfunctions.net` one.

The dev server is pinned to **port 5173 with `strictPort: true`** — this is
deliberate, not incidental. The API only sends CORS headers to an allowlisted
origin, so if you let Vite fall through to another port the app will be blocked.
If 5173 is occupied, free it rather than changing the port.

Other scripts: `npm run build` (tsc + vite build), `npm run lint` (oxlint).

## 4. poker_pal (Flutter Android client)

```powershell
cd poker_pal
flutter pub get
flutter run
```

That is the whole setup. Specifically, **do not** try to restore these — they are
gitignored by Flutter's own defaults and are regenerated automatically:
`android/gradlew`, `android/gradle/wrapper/gradle-wrapper.jar`,
`android/local.properties`, `.dart_tool/`, `GeneratedPluginRegistrant.*`, and the
iOS/macOS `ephemeral/` folders. Flutter injects the Gradle wrapper on first build.

Firebase needs no setup: `android/app/google-services.json` and
`lib/firebase_options.dart` are both committed.

By default the app talks to the **deployed** API. To point it at your local
emulator instead:

```powershell
# physical handset over USB:
adb reverse tcp:5001 tcp:5001
flutter run --dart-define=API_BASE_URL=http://127.0.0.1:5001/pokerpal-a1451/us-central1/api

# Android emulator (no adb reverse; the host is 10.0.2.2):
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:5001/pokerpal-a1451/us-central1/api
```

The settings screen surfaces when the base URL has been overridden, so a debug
build is never mistaken for production data.

**Release builds will not sign.** No `key.properties` or `.jks` keystore exists
in the repo (correctly — `android/.gitignore` excludes them) and none was carried
over from the original machine. Debug builds and `flutter run` work fine; if a
release build is needed, a keystore has to be created and configured first. Ask
before doing that rather than generating one unilaterally.

## 5. Verify the whole stack

1. Functions emulator running and reporting the `api` function on port 5001.
2. `npm run dev` in `poker_pal_web` → open http://localhost:5173, sign in, and
   confirm tournament data loads without CORS errors in the browser console.
3. `flutter run` with the `--dart-define` above → confirm the app reaches the
   same emulator and the settings screen shows the override.

## Known gaps (not blockers)

- `poker_pal_web/README.md` is still the stock Vite template — it does not
  document the `.env.local` step or the port pinning. This file is the real
  source of truth for web setup.
- All three repos are **private**. Make sure the GitHub account on the new
  machine has access to all of them, and that `gh auth login` (or a credential
  helper) is set up before cloning.
