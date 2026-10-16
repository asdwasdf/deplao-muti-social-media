# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

Deplao is a cross-platform Electron desktop application for operating multiple Zalo, Facebook, Telegram Bot, and Telegram User accounts. It combines a unified inbox with CRM campaigns, workflow automation, external business integrations, analytics, ERP, employee workspaces, and local-first storage.

The repository also contains a separate public landing site under `landing/` and a Go helper binary under `src/bridge-e2ee/` for Facebook Messenger E2EE.

## Toolchain and commands

Use Node.js 22 to match CI. The README states Node.js 18+ and npm 9+, but GitHub Actions builds with Node.js 22. Install root dependencies with the lockfile and legacy peer resolution:

```powershell
npm ci --legacy-peer-deps
```

For local development when intentionally updating dependencies, the documented command is:

```powershell
npm install --legacy-peer-deps
```

### Desktop app

```powershell
# Build the Go E2EE bridge, compile Electron, then run Vite + Electron watchers
npm run dev

# Compile Electron main/preload/services only
npm run build:electron

# Build renderer only
npm run build:renderer

# Build the optional Facebook E2EE Go bridge (requires Go >= 1.24)
npm run build:bridge-e2ee

# Rebuild better-sqlite3 against the installed Electron ABI
npm run rebuild:native

# Full production build and platform package; output goes to dist-electron-build/
npm run production
```

`npm run dev` runs the E2EE bridge build first but deliberately continues if that optional build fails. Vite uses fixed port `27799`; Electron waits for that URL before launching.

For faster compile checks without packaging:

```powershell
npx tsc -p tsconfig.electron.json --noEmit
npx tsc -p tsconfig.json --noEmit
```

The renderer-wide check may expose existing type debt because root TypeScript strictness is disabled and normal renderer production compilation is performed by Vite rather than `tsc`.

### Tests and lint

Jest is configured for TypeScript tests matching `src/__tests__/**/*.test.ts`, but no matching tests and no `test` script currently exist. Run Jest directly when tests are added:

```powershell
# All tests; pass when repository currently has no tests
npx jest --passWithNoTests

# One test file
npx jest src/__tests__/Example.test.ts

# One named test
npx jest src/__tests__/Example.test.ts -t "test name"
```

No ESLint configuration or `lint` script exists. Do not claim lint passed; use relevant TypeScript compile checks instead.

### Landing site

The landing site has its own package and lockfile:

```powershell
npm --prefix landing ci
npm --prefix landing run dev
npm --prefix landing run build
npm --prefix landing run preview
```

## Build outputs

Two independent compilation paths feed Electron Builder:

- `tsc -p tsconfig.electron.json` compiles `electron/` plus shared `src/services/`, `src/utils/`, `src/models/`, and `src/configs/` to `dist-electron/` as CommonJS.
- Vite compiles `src/ui/` through root `index.html` to `dist/`. Alias `@` resolves to `src/ui`.
- Electron Builder packages both outputs plus `resources/` and native/runtime assets into `dist-electron-build/`.
- Production uses `tsconfig.electron.prod.json`, strips console calls, minifies and obfuscates first-party renderer chunks, rebuilds `better-sqlite3`, then packages with Electron Builder.
- Platform targets are Windows NSIS/directory x64, macOS DMG/ZIP x64 and arm64, and Linux AppImage/DEB.

GitHub Actions builds from version tags or manual dispatch. Platform workflows use `npm ci --legacy-peer-deps`; Linux also installs Go and builds the E2EE bridge.

## Runtime architecture

### Electron boundary

`electron/main.ts` is the desktop entry point. Startup order matters:

1. Register custom protocols and acquire the single-instance lock.
2. Initialize `WorkspaceManager` before `DatabaseService`.
3. Create the browser window and tray.
4. Register domain IPC handlers from `electron/ipc/`.
5. Reconnect Facebook, Telegram, and Zalo accounts; start health checks and background schedulers.
6. Initialize workflow engine, integration registry, relay services, and webhook gateways.

The browser window uses `contextIsolation: true` and `nodeIntegration: false`. Renderer access to privileged operations must cross the API exposed by `electron/preload.ts`; corresponding typed wrappers/declarations live in `src/ui/lib/ipc.ts`. When adding a renderer-to-main operation, keep all three layers aligned:

1. handler in the appropriate `electron/ipc/*Ipc.ts` module,
2. exposure in `electron/preload.ts`,
3. renderer type/wrapper in `src/ui/lib/ipc.ts`.

Do not import Node/Electron APIs directly into React components.

### Renderer

`src/ui/main.tsx` mounts the single React app in `src/ui/App.tsx`. Navigation is store-driven rather than React Router-driven in the desktop app. Major views are composed from `src/ui/components/` and `src/ui/features/erp/`.

Zustand stores under `src/ui/store/` own UI, account, chat, CRM, workspace, employee, update, and ERP state. Hooks under `src/ui/hooks/` subscribe to IPC/realtime events and update stores. Channel-specific UI behavior should use the capability matrix in `src/configs/channelConfig.ts`; it is the shared source of truth for Zalo/Facebook/Telegram feature support and legacy channel normalization.

### Local versus employee data access

`src/ui/lib/data/DataAccessor.ts` is the routing seam for data operations:

- standalone/boss/local workspace: call `window.electronAPI` through IPC;
- employee/remote workspace: call `RestQueryService`, which accesses the boss app over HTTP REST.

New UI data reads/writes that must work in employee mode should go through `DataAccessor`, not call `ipc.db` directly. Boss relay services live in `src/services/http/`; REST endpoint implementation is in `src/services/http/handlers/`. Realtime employee events use Socket.IO through the HTTP connection/relay layer.

### Persistence and workspaces

`DatabaseService` is a singleton backed by `better-sqlite3` in WAL mode. It owns schema creation and inline migrations for chat, CRM, workflows, integrations, ERP, and related data. There is no separate migration framework.

`WorkspaceManager` stores workspace metadata in Electron `userData/workspaces.json`. Every local workspace has an independent SQLite DB and media directory. The default legacy DB is `deplao-tool.db`; additional workspaces use `workspace-{id}/deplao-tool.db`. Remote workspaces retain boss URL, employee identity/token, permissions, assigned accounts, and small offline caches.

Workspace switching closes/checkpoints the active DB and reinitializes services. Preserve startup invariant: `WorkspaceManager.initialize()` must run before `DatabaseService.initialize()`. Before DB copy, move, workspace switch, update install, or quit, retain WAL checkpoint/close behavior to avoid data loss.

Credentials and sessions are protected with Electron `safeStorage` where available. Do not move credential handling into renderer or log decrypted values.

### Messaging and events

Channel services live under:

- `src/services/zalo/` for Zalo sessions and realtime APIs,
- `src/services/facebook/` for Facebook sessions, MQTT, sending, and E2EE bridge management,
- `src/services/telegram/` for Telegram Bot API and Telegram User/MTProto listeners.

`EventBroadcaster` is the central main-process event path. Incoming channel events are normalized, persisted through `DatabaseService`, optionally downloaded through `FileStorageService`, passed to workflow/relay hooks, then sent to renderer via Electron IPC. It contains workspace-aware rules so boss data remains source of truth while a remote employee workspace is displayed. Avoid bypassing this path for incoming message events; doing so can miss persistence, workflow triggers, relay forwarding, media localization, or duplicate-loop guards.

### Workflows and integrations

`WorkflowEngineService` loads workflow graphs from SQLite, subscribes to `EventBroadcaster`, registers cron triggers, and executes channel, logic, data, AI, Google Sheets, notification, HTTP, and integration nodes. Workflow definitions are persisted as node/edge JSON.

`IntegrationRegistry` loads enabled adapter configs from SQLite, decrypts credentials only in main process, maps integration types to adapters under `src/services/integrations/adapters/`, and serves actions to UI/workflows. Add a new integration by implementing `IntegrationAdapter`, registering it in the registry factory, and adding matching UI/workflow support only where required.

## Important constraints

- Keep main/preload/renderer separation intact. Renderer is not a trusted Node context.
- Treat SQLite DB and media files as user data. Never replace a failed persistent DB with silent fresh storage or remove recovery backups.
- Keep channel behavior capability-driven via `channelConfig.ts`; do not scatter new channel-name conditionals when a capability flag fits.
- Preserve local/boss versus employee routing through `DataAccessor` and REST handlers.
- Native dependency `better-sqlite3` must match Electron ABI before packaging.
- `src/bridge-e2ee/meta/` may be cloned by the bridge build script and is not normal application source. Go bridge output is copied into packaged resources.
- Environment controls observed in source: `NODE_ENV`, `BUILD_TARGET`, optional `FBCHAT_E2EE_BIN`, and optional `TELEGRAM_VERBOSE_LOGGING`. No committed `.env` contract exists.
