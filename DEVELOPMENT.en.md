# Development guide

> [简体中文](DEVELOPMENT.md) · [English](DEVELOPMENT.en.md)

This guide describes the Teahouse codebase, process boundaries, data flow, and the safest starting point for common extensions.

- Product overview and installation: [README](README.en.md)
- Setup, hard constraints, testing, and packaging: [Contributing](CONTRIBUTING.en.md)
- Current architecture and extension points: this document

Teahouse is a serverless, IP-based LAN messenger and file-transfer application. Every client is an equal peer and all runtime data stays on the local network.

## Technology stack

| Area | Technology | Notes |
|---|---|---|
| Desktop runtime | **Electron 22.3.27** | Exact pin; final major version supporting Windows 7 |
| Renderer | **Vue 3** and **Pinia** | Compiled for Chrome 108 |
| Language | **TypeScript 5.6**, strict mode | Shared across main, preload, and renderer code |
| Storage | **better-sqlite3 9.6**, WAL | The only native dependency |
| Build | **electron-vite 2** and **Vite 5** | Separate main, preload, and renderer bundles |
| Tests | **Vitest 2** | Pure units plus loopback network integration |
| Packaging | **electron-builder 24** | NSIS, portable, deb, AppImage, dmg, and zip |
| Local OCR | **PaddleOCR PP-OCRv6 tiny** and **onnxruntime-web 1.20.1** | Model and WASM assets are bundled locally |

## Runtime baselines

- Main and preload processes run on **Node 16.17**. Global `fetch` and `structuredClone` are unavailable.
- Renderer processes run on **Chrome 108**. Native CSS nesting, Popover, `text-wrap: balance`, and subgrid are unavailable.
- `electron.vite.config.ts` fixes these targets at `node16` and `chrome108`.

Review the [hard constraints](CONTRIBUTING.en.md#hard-constraints) before changing runtime code or dependencies.

Native installation and `npm run rebuild:electron` call the same pinned `@electron/rebuild` through its official programmatic API in `scripts/rebuild-electron.cjs`. This avoids the old CLI’s `yargs/yargs` ESM loading failure on Node26. Only `better-sqlite3` is rebuilt, targeting the project’s pinned Electron; force rebuilds and `npm_config_build_from_source=true` remain supported. Neither Electron nor global Node settings are changed.

## Process model

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer processes — Chrome 108, Vue 3, Pinia            │
│ Main / Settings / Capture / Images / Screen / Agents / Board              │
│ Display and interaction; state projects the main process │
└────────────────────────────┬─────────────────────────────┘
                             │ window.pantry only
                             │ contextBridge in preload
┌────────────────────────────┴─────────────────────────────┐
│ Main process — Node 16.17                                │
│ net/       discovery, messaging, transfer                │
│ store/     SQLite repositories and full-text search      │
│ services/  use-case orchestration                        │
│ windows/   tray and auxiliary windows                    │
│ index.ts   assembly, IPC validation, desktop integration │
└──────────────────────────────────────────────────────────┘
```

The dependency rules are strict:

1. Renderer code imports no Electron or Node runtime module. It calls capabilities exposed through `window.pantry`.
2. `net/` and `store/` have no Electron dependency and do not depend on each other.
3. Business orchestration belongs in `services/`. IPC handlers validate parameters and forward calls.
4. `shared/` contains dependency-free types and constants.

## Repository map

```text
pantry/
├─ src/
│  ├─ shared/
│  │  ├─ protocol.ts       # Wire types and constants
│  │  ├─ ipc.ts            # PantryApi contract
│  │  ├─ pk.ts             # Rock-paper-scissors and dice data
│  │  └─ compat-emoji.ts   # Local emoji compatibility map
│  ├─ preload/
│  │  └─ index.ts          # The only contextBridge entry
│  ├─ main/
│  │  ├─ index.ts          # Assembly, IPC handlers, system integration
│  │  ├─ notifications.ts  # Desktop notifications
│  │  ├─ net/
│  │  │  ├─ codec.ts       # JSON codec and inbound allowlist validation
│  │  │  ├─ udp.ts         # UDP transport, broadcast, and limits
│  │  │  ├─ discovery.ts   # Entry, exit, heartbeat, gossip, probing
│  │  │  ├─ messenger.ts   # Reliable delivery and retry queues
│  │  │  ├─ transfer.ts    # Pull-based TCP file data plane
│  │  │  ├─ frame.ts       # TCP control and long-message frames
│  │  │  ├─ cidr.ts        # CIDR range calculations
│  │  │  ├─ peer-registry.ts
│  │  │  ├─ peer-clock.ts
│  │  │  └─ range-sync.ts
│  │  ├─ store/
│  │  │  ├─ db.ts          # SQLite WAL connection
│  │  │  ├─ migrations.ts  # Append-only user_version migrations
│  │  │  ├─ *-repo.ts      # Peer, conversation, message, queue, group, transfer, share repositories
│  │  │  ├─ fts.ts         # Chinese character-level full-text search
│  │  │  ├─ app-state.ts   # Identity and local configuration
│  │  │  └─ db-selftest.ts
│  │  ├─ services/
│  │  │  ├─ chat.ts        # Private messaging
│  │  │  ├─ groups.ts      # Discussion groups
│  │  │  ├─ files.ts       # Files, folders, images, and transfer offers
│  │  │  ├─ share.ts       # Shared file cabinet permissions and browsing
│  │  │  ├─ search.ts      # Search orchestration
│  │  │  ├─ forward.ts     # Message forwarding
│  │  │  ├─ porter.ts      # .pantry-bak export and import
│  │  │  └─ image-ocr-cache.ts
│  │  ├─ util/             # Pure path, archive, formatting, and write helpers
│  │  └─ windows/          # Tray, Settings, Capture, and Image viewer windows
│  └─ renderer/
│     ├─ src/
│     │  ├─ main.ts        # Hash-based routing to seven renderer roots
│     │  ├─ App.vue        # Main window and three main tabs
│     │  ├─ SettingsApp.vue
│     │  ├─ CaptureApp.vue
│     │  ├─ ImageViewerApp.vue
│     │  ├─ stores/        # Pinia projections of main-process state
│     │  ├─ components/    # Chats, contacts, groups, transfers, cabinet UI
│     │  ├─ utils/         # Clipboard, emoji, time, avatar, and OCR helpers
│     │  ├─ styles/tokens.css
│     │  └─ assets/        # Local brand, font, emoji, and artwork assets
│     └─ public/ocr/       # Prepared local OCR runtime assets
├─ build/                  # Package icons and installer resources
├─ scripts/                # Validation, CI, packaging, and developer helpers
├─ docs/                   # Canonical Chinese designs and English translations
├─ references/             # Local research checkouts
├─ .github/workflows/      # Multi-platform release pipeline
└─ electron.vite.config.ts # node16 and chrome108 build targets
```

Most implementation files have adjacent `*.test.ts` coverage. Electron-free network, store, and utility modules can run directly under Vitest.

## Message data flow

Sending a text message:

```text
Renderer calls window.pantry
  → preload forwards to a validated IPC handler
  → services/chat stores the message and invokes networking
  → net/messenger encodes it and sends UDP+ACK or a TCP frame
  → the main process emits stored/status events
  → Pinia updates the visible conversation
```

Receiving a message:

```text
net/udp receives a datagram
  → codec performs type, length, and field allowlist validation
  → discovery or messenger dispatches and acknowledges it
  → services persist and deduplicate it by envelope ID
  → the main process emits an event to renderer stores
```

The message ID is also the envelope and deduplication key. Group delivery reuses one envelope ID across member-specific sends. File transfer is a pull-based TCP stream with `.part` resume files and SHA-256 integrity verification.

## Common extension paths

| Goal | Change order |
|---|---|
| Add a wire message type | `docs/protocol.md` → `shared/protocol.ts` → `net/codec.ts` validator → network/service handling → renderer → tests |
| Add a renderer component | Add under `renderer/src/components/`; use `window.pantry`; use variables from `styles/tokens.css` |
| Add a setting | `shared/ipc.ts` → preload bridge → validated main handler → `store/app-state.ts` → Settings UI |
| Add a table or column | Append a migration in `store/migrations.ts` → repository update → `npm run test:db` |
| Add an auxiliary window | Add a module under `main/windows/` and route a renderer root through `main.ts` |
| Expose a main-process capability | `shared/ipc.ts` → preload → validated handler → service implementation |

Protocol changes begin in the canonical protocol document and retain strict inbound allowlists. Unknown types are ignored to allow newer peers to coexist with older clients.

## Storage and migrations

SQLite uses WAL mode. Migrations use `PRAGMA user_version` and are append-only: add a new migration entry and never rewrite a migration shipped in a release. Run the database self-test through Electron because the native module uses Electron ABI 110.

The application data directory stores identity, configuration, databases, managed media, thumbnails, avatars, logs, and partial transfers. Renderer code never receives unrestricted local filesystem access; paths enter through main-process selection and authorization flows.

## Renderer design

The main window has three application tabs: Chat, Contacts, and File Cabinet. Settings, Capture, and Image Viewer remain separate renderer roots. `src/renderer/src/styles/tokens.css` is the single source for color, type scale, radius, spacing, elevation, and motion tokens.

Naive UI 2.43.2 is used selectively for standard forms, search, and common actions. It is imported through renderer entry points and styled through the centralized Teahouse theme mapping. Specialized chat, cabinet, capture, and brand surfaces remain project components.

## Tests and delivery

```bash
npm test
npm run test:db
npm run typecheck
npm run build
npm run smoke
```

Network tests use `127.0.0.1` and empty broadcast targets. Use `npm run dev:2` or `npm run dev:3` for real local discovery, message, and file flows with isolated client data.

Package and lock versions must advance with each complete increment. The GitHub Actions release workflow builds multi-platform installers; after a push to `main` passes all platform and artifact version checks, it creates an annotated version tag and publishes the Release, skipping publication if the tag already exists remotely. Tag-triggered releases remain supported; manual dispatch publishes only on a `v*` tag.


## Agent and board-game extension boundaries

- `src/shared/agents.ts` defines the configuration allowlist and literal LAN IPv4 validation. `store/agent-store.ts` atomically stores separate configuration with system-encrypted keys, or memory-only session keys when the secure backend cannot be verified. Existing chat schema is unchanged.
- `services/agents/model.ts` uses pinned `@anthropic-ai/sdk@0.32.1`, its explicit Node shim and `node-fetch@2.7.0`. It does not rely on global fetch or inherit cloud credentials. Keep exact-target enforcement, redirect/retry rejection, total deadlines, response byte caps and the SDK DEBUG guard.
- **Compatibility acceptance:** the SDK 0.32.1 upstream README officially lists Node18+. The pinned version has passed `test:agents` on macOS arm64 with Electron22.3.27 / Node16.17.1, including real SQLite, local HTTP model requests, private TCP messages, group mentions and exit. This verifies the tested paths, not upstream support, and does not replace Windows/Linux or real multi-client desktop acceptance. Rerun native tests after any SDK upgrade.
- `services/agents/runtime.ts` gives each Agent its own dynamic UDP port and real TCP control endpoint, reusing Discovery, Messenger, ChatService, GroupsService and a new independent database. Dynamic ports use directed probes to the host and known peers plus gossip, not same-port broadcasts. Contacts are not fabricated in the UI. Personas/keys stay out of profiles; the `agent1` capability prevents reply loops.
- `shared/board-games/` contains pure rules and bounded packet validation. `services/board-games.ts` provides host arbitration, dynamic group authorization, revision conflict recovery and threefold repetition counting. The wire type is `board`, capability `board1`. Reliable snapshots exceeding UDP limits use existing TCP frames. Sources bind to known peer IPs; a room ID alone is not authority.
- Invitations store `BoardInvite` in an existing text message's `file_ref`, with ID `board:<roomId>`. No new message kind or existing-database migration is needed. Old clients ignore unknown control packets and cannot move.
- Agent manager and board are separate renderer roots. `windows/extension-windows.ts` shares sandbox/navigation protection, appearance-ready gating and zoom synchronization. Management/move IPC binds to the owning webContents; state is pushed only to its window. The bundle checker now covers seven roots without raising the main-window budget.
- Run `npm test`, `npm run typecheck` and `npm run build`. Model tests use loopback HTTP mocks, never real model calls or billed keys. Actual Agent native-database behavior, cross-client discovery and desktop interactions need separate Electron acceptance. Development-host tests are not Node16 runtime proof.


Run `npm run test:agents` for native acceptance inside Electron’s Node16: SDK and local model mock, real SQLite, discovery between two users and an Agent, long TCP messages, explicit group mentions and exit/offline behavior. It uses only temporary directories and loopback ports. If the Electron binary is unavailable, this check remains unverified.

## Publishing and verifying cabinet updates

Updates reuse the existing `share-get` transfer. The receiver fixes the publisher node, relative folder, single filename, and byte limit. Manifests are limited to 64 KiB and packages to 512 MiB. Versions use exactly three stable numeric components. Required fields are `schema: 1`, `platform: "mac"`, `arch: "arm64"`, `version`, `file`, `size`, `sha256`, `notes` of at most 4000 characters, and `dataCompatible: true`. Unknown fields are rejected.

Generate the manifest after building and signing the package. The `--compatible-data` flag explicitly declares that the release contains no incompatible data migrations.

```sh
npm run update:manifest -- /path/to/Teahouse-0.66.0-mac-arm64.dmg --compatible-data --notes /path/to/notes.txt
```

The generator streams the hash, checks for changes during reading, and atomically writes `teahouse-update.json` next to the package. Publish the complete versioned package first, then replace the manifest last. Keep published versioned files immutable. Restrict writes to the trusted publisher and grant recipients cabinet read access. Current node identity and ad-hoc signatures do not cryptographically authenticate the publisher. SHA256 provides integrity checking.

The app ships its own installer helper through `extraResources`. The main process mounts the DMG read-only, verifies `com.pantry.app`, version, arm64 architecture, complete signatures, and link boundaries, then copies the app to `.teahouse-update-<random-ID>/next.app` beside the installed app. The old app quits after the helper acknowledges readiness. The helper backs up and replaces the bundle, starts the new process, and waits for its rendered UI handshake. It attempts rollback once on failure. Successful `previous.app` backups remain for seven days and are cleaned on a later startup using this feature’s transaction metadata. Failed transactions remain for inspection. Rollback restores the app bundle, so publishers must ensure backward-compatible data.

The cache lives under the app data directory at `data/updates/cabinet`. Changing sources, canceling, sleeping, and quitting revoke download authorization. Legacy cabinet offers lack a request ID, so update downloads and ordinary pending downloads from the same publisher are mutually exclusive. The existing transfer protocol remains compatible.

```sh
npm run build
PANTRY_CABINET_TEST=1 node scripts/extension-ui-selftest.cjs
npm run test:macos-update
```

Desktop verification uses two isolated Electron clients and 127.0.0.1. It covers browsing, an older running publisher offering a newer package, prompt deduplication, confirmation, progress, integrity, permissions, corrupt manifests, and both languages and themes. Native tests create signed Mach-O fixtures in `out/` for successful replacement, a live parent process, denied permissions, invalid signatures, and startup rollback. If clang and the default SDK mismatch, set a compatible `SDKROOT` for the individual test command.

For a complete Electron package test, add `PANTRY_UPDATE_DMG=<signed DMG within this project>` and `PANTRY_UPDATE_BASE_APP=<old app copy within this project>` to the native command. It uses production preparation and helper launch functions, verifies package resources, and waits for the new app’s UI handshake. Add the same variables to the desktop test with `PANTRY_CABINET_TEST=1` to download the real DMG through the cabinet and install the cache verified by the production downloader. The test manifest uses version 0.66.0, so the fixture package must match. Installation targets are freshly created copies in `out/`, with isolated user data and loopback networking. Detach test disk images after inspection so file discovery does not follow their Applications shortcut into system folders.

## macOS LAN test package signing

A package without a developer certificate still needs a complete resource seal. Setting only mac.identity=null leaves Electron’s linker ad-hoc signature behind and may produce a “damaged” warning on another Mac. Enable the dedicated afterPack hook explicitly for LAN testing; do not change the normal signing path or system protections.

Run npm run build first, choose a new empty output directory, then run:

```sh
node node_modules/electron-builder/cli.js --mac dmg --arm64 --publish never --config.electronDist=node_modules/electron/dist --config.mac.identity=null --config.afterPack=./scripts/sign-mac-lan.cjs --config.directories.output=release/lan-fixed
```

The hook reuses the existing official @electron/osx-sign library and electron-builder’s standard Electron entitlement template. It retains hardened runtime, JIT and the app-scoped permissions needed to load bundled frameworks/SQLite, without personal certificates, remote timestamps or extra camera/location permissions. Signing or strict verification failures stop packaging. Leave strictVerify unset: the old library maps true to the invalid --strict=true rather than --strict.

Before delivery, run codesign --verify --deep --strict on the bundled app and hdiutil verify on the DMG, then smoke-test from a read-only mount with temporary user data and PANTRY_SMOKE=1. Ad-hoc signing is not Apple Developer ID signing or notarization. Gatekeeper may still block it; approve the individual app in System Settings → Privacy & Security, or contact the administrator of a managed device. Do not disable Gatekeeper globally. Compare SHA256 on the receiving Mac and retransmit if it differs.
