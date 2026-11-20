<div align="center">

<p><a href="README.md">简体中文</a> · <b>English</b></p>

<img src="build/icons/pantry-logo-icon.png" alt="Teahouse logo" width="120" height="120" />

<h1>茶话间 &nbsp;·&nbsp; Teahouse</h1>

<p><b>Chat and transfer files across a LAN, with no Internet connection or server</b></p>

<p>
  <a href="https://github.com/skyjt/teahouse/releases/latest">
    <img src="https://img.shields.io/github/v/release/skyjt/teahouse?style=flat-square&label=latest&color=3D8B6B&logo=github&logoColor=white" alt="Latest release" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0--only-3D8B6B?style=flat-square" alt="GPL-3.0-only" />
  </a>
  <a href="https://github.com/skyjt/teahouse/releases">
    <img src="https://img.shields.io/badge/platform-Windows%207%2B%20%7C%20Linux%20%7C%20macOS-0366d6?style=flat-square" alt="Supported platforms" />
  </a>
  <img src="https://img.shields.io/badge/Electron-22-47848F?style=flat-square&logo=electron&logoColor=white" alt="Electron 22" />
</p>

<p>
  <a href="#why-teahouse">Why Teahouse</a>
  &nbsp;·&nbsp;
  <a href="#features">Features</a>
  &nbsp;·&nbsp;
  <a href="#platform-support">Platforms</a>
  &nbsp;·&nbsp;
  <a href="#installation">Installation</a>
  &nbsp;·&nbsp;
  <a href="#usage">Usage</a>
  &nbsp;·&nbsp;
  <a href="#how-it-works">How it works</a>
  &nbsp;·&nbsp;
  <a href="#security">Security</a>
  &nbsp;·&nbsp;
  <a href="#development">Development</a>
</p>

</div>

---

Start Teahouse on computers connected to the same local network and they discover each other automatically. Open a peer to chat or transfer files directly. No cloud account, central server, telemetry, or Internet access is involved. Teahouse is designed for corporate intranets, isolated networks, and laboratories where external connectivity is limited or prohibited.

## Why Teahouse

Moving a file or sending a short message inside an office network should be effortless. Existing tools often miss at least one requirement: commercial solutions require licensing fees, Neiwangtong provides only Windows binaries without support for domestic UOS or macOS, and iptux presents a steeper learning curve for regular office users. Teahouse aims for an open-source, serverless, zero-configuration experience across Windows 7, domestic UOS deployments, Linux, and macOS.

## Features

- **Zero-configuration peer discovery** — UDP broadcast discovers online peers on the same subnet automatically. Peers communicate directly without deploying a central server or manually configuring IP addresses.
- **Cross-subnet communication & LAN self-updates** — Supports manual peer IP addition and CIDR subnet scanning; saved scan ranges are shared among online peers at a low rate; provides a global subnet scan trigger with real-time progress; supports P2P package requests for LAN-based self-updating.
- **Messaging & group collaboration** — Direct chats and multi-user discussion groups; text, local images, pasted screenshots, Twemoji SVG graphics, and custom sticker collections; delivery acknowledgments, offline queuing with automatic retry upon reconnection, 2-minute message recall, message forwarding, quote replies with jump-to-source navigation, and @ mentions in groups; synchronized group descriptions (≤200 characters) and announcements (≤1024 characters); window nudge alerts.
- **High-speed P2P file transfers** — Direct TCP peer-to-peer transfers maximize LAN physical bandwidth; supports single files, multi-file selections, and full directory trees; resume interrupted transfers and review comprehensive transfer history; 24-hour expiration window closes outdated transfers automatically.
- **Shared file cabinet (third main tab)** — Built natively into the third tab of the main window; publish a local folder with configurable global permissions (disabled, read-only, read-write) and granular per-peer grants; browse colleagues' shared cabinets with breadcrumb navigation and pagination; multi-select download and save-as; drag-and-drop upload of files or folders into dedicated subdirectories to avoid overwriting existing data; aggregate recent upload activity.
- **Standalone image viewer & offline OCR** — Independent image viewer with smooth zooming, double-click mouse-anchored zooming, rotation, and window centering; browse chat image history seamlessly using previous/next navigation buttons; built-in PaddleOCR (PP-OCRv6 tiny + onnxruntime-web WASM) fully offline text recognition engine; directly select, drag across lines, and copy text on top of the original image, plus one-click copy of all recognized text; session-level in-memory caching restores the text selection layer instantly.
- **Built-in screenshot utility** — One-key global shortcut capture; rectangular selection, pencil, arrows, mosaic, and in-place single-line text annotations; includes a magnifier and coordinate/color inspector; compatible with Linux Wayland and X11 environments.
- **View-only screen assistance** — Request from a private chat; the peer consents and selects a screen each time. An independent viewer provides Auto and 3/5/10 fps modes with immediate stop. Plaintext LAN transport; local loopback and synthetic Electron capture are validated, while physical-screen permissions and target performance remain pending. See [technical boundaries](docs/en/tech-design.md#remote-view).
- **Local history & full-text search** — Powered by SQLite WAL mode and FTS full-text index; quickly search contacts, groups, and message history globally or filter within a specific chat; supports local backup export and device migration.
- **Bilingual interface switching** — Native support for Simplified Chinese and English; switch instantly across all active windows via Settings → General → Language; fresh installations initialize automatically based on system locale.
- **LAN security boundary** — Globally appends `--no-proxy-server` at startup to bypass any system or environment proxies; zero external network requests, zero telemetry, and zero remote CDN dependencies; context isolation and Chromium sandboxing enabled in renderers; strict network packet allowlist validation; destination path traversal sanitization; inline chat images bounded to ≤8192px and ≤32 megapixels; strict log sanitization keeping message bodies and file contents out of logs.

## Platform support

| Platform | Supported versions | Architectures | Packages | Hardware-tested coverage |
|---|---|---|---|---|
| Windows | Windows 7 SP1 through Windows 11 | x64 / ia32 | NSIS installer, portable executable | Windows 7 x64; ia32 build verified |
| UnionTech UOS / Kylin | UOS 20 and later, Kylin V10 | x64 / arm64 | `.deb` | UOS 20 x64; arm64 build verified |
| macOS | macOS 12 Monterey and later | Apple Silicon | `.dmg`, `.zip` | macOS 12+ / Apple Silicon |
| Debian / Ubuntu and related distributions | Debian 10 Buster and later | x64 / arm64 | `.deb`, AppImage | Build verified |

The hardware-tested column distinguishes an installation and messaging test on the named operating system from CI-only package validation.

Electron is pinned to **22.3.27**, the final major release supporting Windows 7. This compatibility baseline is permanent. See [Contributing](CONTRIBUTING.en.md#hard-constraints) before changing dependencies or runtime code.

## Installation

Download the package for your platform from [GitHub Releases](https://github.com/skyjt/teahouse/releases).

**Windows** — Choose the x64 or ia32 NSIS installer for your system, or use the matching portable executable. Windows 7 requires **SP1**. If a signed build is used on an unpatched Windows 7 installation, install KB4474419 first.

**Linux** — Use the `.deb` package on Debian, Ubuntu, UOS, Kylin, and compatible distributions. For other distributions, mark the AppImage executable and run it:

```bash
chmod +x Teahouse-*.AppImage
./Teahouse-*.AppImage
```

**macOS** — Open the `.dmg` and drag Teahouse into Applications. An unsigned or unnotarized intranet build may require approval under System Settings → Privacy & Security. You can also remove the quarantine attribute in terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Teahouse.app
```

## Usage

1. Start Teahouse on each device connected to the LAN. Peers on the same subnet appear automatically in the left contact list.
2. Select a peer to start a private chat, click the plus icon to create a discussion group, or drag files and folders into the chat window to send them.
3. Switch to the File Cabinet tab in the navigation rail to browse files shared by colleagues, or publish your own shared folder with custom access permissions.
4. **Cross-subnet communication**: For routed subnets where UDP broadcast does not cross boundaries, add peer IPs or configure CIDR scan ranges in Settings → Network. Saved ranges are shared at a low rate among online peers. Click the refresh button at the bottom of the navigation rail to scan all ranges with live progress.
5. **Image viewing & text recognition**: Double-click an image in chat to open the standalone viewer, use the side arrows to navigate session image history, or click "Recognize Text" to select and copy text directly from the image.
6. Allow the application through the operating-system firewall when prompted. Default ports are UDP `17878` and TCP `17879`.

**Group shortcuts:** Type `@` to choose a member; “Everyone” appears after the member list. Type `@all`, `@everyone`, or the Chinese equivalents to move it to the top. Select the candidate to attach a real mention; typing the label alone does not notify everyone. Older clients may not recognize everyone mentions, so keep group members on compatible versions. Click another member's avatar in a group message or the member list to mention them or start a direct chat. Former members cannot be mentioned, and unknown contacts have no direct-chat action. Your own ordinary messages display the nickname and avatar from your profile settings.

## How it works

Each client is an equal peer (P2P), with **no central server**:

```text
Renderer process (UI) — session list, chat panel, shared file cabinet, image viewer, settings
   │  IPC exposed exclusively through context-isolated preload bridges
Main process
   ├─ Network (Net)     : UDP discovery & heartbeat, UDP+ACK / TCP message channel, TCP file transfer
   ├─ Services          : contacts, groups, file cabinet service, offline delivery queue
   ├─ Storage (Store)   : SQLite (WAL mode + FTS index, persisting history, groups, grants, and transfers)
   └─ Desktop (System)  : tray, notifications, global shortcuts, OCR coordination & window management
```

| Channel / Component | Transport | Default ports | Purpose |
|---|---|---|---|
| Peer Discovery | UDP broadcast & unicast | 17878 | Online announcement, response, heartbeat, offline exit, and subnet exchange |
| Control & Short Messages | UDP with ACK/retry | 17878 | Text messages, delivery receipts, recall, window nudges, group events, cabinet metadata |
| Long Message Channel | Direct TCP | 17879 | Fallback channel for lengthy messages exceeding UDP MTU |
| File & Data Transfer | Direct TCP | 17879 | Chunked verified file/folder transfers, cabinet uploads/downloads, LAN P2P self-updates |

The discovery sequence takes inspiration from IP Messenger, while Teahouse uses its own UTF-8 JSON protocol and does not claim wire compatibility with legacy ipmsg clients.

## Security

- **Strict LAN boundary** — All communication is strictly bounded to the local network; `--no-proxy-server` is appended at startup to bypass system proxies; zero external calls, telemetry, or remote updates.
- **Minimal renderer attack surface** — Renderers load locally packaged resources only. `contextIsolation` and Chromium sandboxing are enforced, `nodeIntegration` is disabled, window navigation and opening are denied, and strict CSP is applied.
- **Untrusted input validation** — Incoming network packets undergo strict schema and length allowlist validation; unknown message types are ignored gracefully; inline images are bounded to ≤8192px and ≤32 megapixels to prevent decoder OOM.
- **Safe file persistence** — Incoming file names are sanitized against path traversal; files are saved exclusively to user-selected or isolated subdirectories with automatic conflict renaming to prevent overwrites; cabinet uploads are restricted to dedicated peer folders.
- **Operational log sanitization** — Message contents and transferred file data are never written to disk logs; only transaction IDs, status codes, and file byte sizes are recorded.
- **Physical LAN trust model** — Teahouse adopts the unencrypted LAN transmission model of classic tools like IP Messenger and iptux, intended for operation within trusted intranet perimeters and isolated laboratory networks.

## Development

- [Contributing](CONTRIBUTING.en.md) covers setup, builds, tests, hard constraints, and release packaging.
- [Development guide](DEVELOPMENT.en.md) explains architecture, data flow, and extension points.
- [Documentation index](docs/en/README.md) links the English requirements, protocol, UI, technical design, handoff, compatibility, and optimization documents.

Please report bugs and feature requests through [GitHub Issues](https://github.com/skyjt/teahouse/issues).

## Related projects

- [IP Messenger](https://ipmsg.org/) — the original LAN messaging protocol that inspired the discovery model.
- [iptux](https://github.com/iptux-src/iptux) — an open-source IP Messenger-compatible client for Linux.
- FeiQ and Neiwangtong — popular Windows LAN messengers used as product references.

## Third-party resources

Standard renderer controls use [Naive UI](https://github.com/tusen-ai/naive-ui) 2.43.2 (locally bundled, MIT). Built-in avatar and emoji compatibility rendering uses a locally bundled subset of [Twemoji](https://github.com/jdecked/twemoji) (CC-BY 4.0). Built-in offline OCR uses PaddleOCR models and onnxruntime-web. See [Third-party notices](THIRD_PARTY_NOTICES.en.md).

## License

Copyright © 2026 skyjt.

Starting with version 0.37.0, Teahouse source code and binary distributions are licensed under the [GNU General Public License v3.0 only](LICENSE), SPDX identifier `GPL-3.0-only`. MIT rights granted for version 0.36.8 and earlier remain valid. Third-party components and artwork retain the licenses listed in [Third-party notices](THIRD_PARTY_NOTICES.en.md).


## Diagnostics and feedback (since v0.60.0)

After a problem, open **Settings → About → Diagnostics and feedback → Export diagnostics**, save a local ZIP and attach it to your Issue manually. **Copy environment info** supplies a redacted summary. Include the time, steps and expected result; for file/image issues, export from both peers and label sender/receiver.

Bundles include versions, OS/architecture/session details, known listener/permission status and recent events. Logs retain up to **seven days and 10 MiB**, excluding chat text, filenames/file contents, screen images, clipboard contents, credentials and raw error messages. Nodes and addresses are aliased by default. The unchecked **Include real network addresses** option adds addresses observed during this run only; confirm they can be shared before posting public attachments. Copied information always stays redacted. The app never uploads or contacts an external service.

If the app cannot open, retrieve `.jsonl` files from `logs`, not the complete data directory, database or `identity-salt`:

| Platform | Default log location |
|---|---|
| Windows | `%APPDATA%\茶话间\logs` |
| Linux / UOS / Kylin | `${XDG_CONFIG_HOME:-~/.config}/茶话间/logs` |
| macOS | `~/Library/Application Support/茶话间/logs` |

Development instances use `PANTRY_USER_DATA/logs` when overridden. Restarted apps can export retained previous-run records. An unclean marker does not establish a crash cause; native crashes/power loss may leave no stack. If logging fails, bounded in-memory records last until exit and the summary reports persistence errors. Packaging runs only during export, with no per-frame logging or continuous performance monitoring.


## LAN Agents and board-game PK

### Create an Agent in the app

Click **AI** beside the contact search field to open **Agent manager**. Enter a name, persona, LAN service base URL, model ID and API key, then enable and save. Leave the key blank when editing to keep it; disable and save to stop hosting. Up to 8 Agents can be configured.

- The service must implement the **Anthropic Messages-compatible API**. For example, `http://192.168.1.10:8000` is called at `/v1/messages`. A proxy prefix is allowed; do not include `/v1` or `/v1/messages` in the base URL.
- Only literal IPv4 addresses in private `10/8`, `172.16/12`, `192.168/16` or loopback `127/8` ranges are allowed. Public addresses, domains, URL credentials and redirects are rejected. HTTPS certificates are verified. HTTP is unencrypted; use only on a trusted LAN.
- Each Agent has a stable independent peer identity. Chat directly or invite it using the existing group-member controls. Group replies require an explicit mention of that Agent; `@Everyone` alone and other Agents do not trigger replies. Removing it from a group uses existing group permissions.
- The creator's app hosts the Agent. Closing the management or board window does not stop it. Disabling, deleting, quitting or sleeping cancels pending requests; enabled Agents restart on resume. Deleting keeps previous chat history and offline contact records rather than erasing other clients' data.
- Keys are never placed in peer profiles, group metadata, logs or UI lists. System-encrypted storage is used when available on macOS/Windows. When the secure backend cannot be verified, including current Electron22 Linux setups, keys stay only in memory and must be re-entered after restart. Configuration, personas and an independent Agent chat database remain on the host device.
- Only direct messages, explicit group mentions and a bounded reply context are sent to the model—not the entire unmentioned group history. Each Agent processes requests serially: 8 queued requests, 32 contexts, 12 context messages, a 60-second total deadline, 1024 output tokens, a 64-KiB response body limit and 4096 UTF-8 bytes per chat reply. No tool execution, web search or autonomous background actions are provided.
- Model calls are refused when SDK `DEBUG=true` would expose request data and keys. User-visible failures are sanitized.

### Images with captions and AI replies

Picking, dropping or pasting an image adds a pending attachment. Type a caption and send once: the text belongs to the first image, not a separate text message that would trigger the Agent early. Multiple images remain separate messages, not an album. Direct and group chats can quote text or images; the image menu includes **Quote reply**. Forwarding retains the caption but not the original conversation's quote ID or mention intent. Older clients may display only the image; update participants together.

- Agents receive real base64 image bytes and the caption through the configured Anthropic-compatible endpoint. The LAN model must support vision. Rejected image requests produce an explicit error rather than silently pretending to analyze the image as text.
- Current AI images support PNG/JPEG/GIF/WebP, up to 5 MiB each, with the existing 8192-pixel maximum edge and 32-million-pixel guard. Each Agent has a 128-MiB local image cache/receive-reservation budget. Failed-transfer reservations are recalculated from actual disk usage when the Agent is enabled again; caches are not automatically deleted. Ordinary files are not sent to the model.
- Quotes are resolved from the Agent's own received messages in the same conversation, never from sender-supplied quote text. Missing, cross-conversation or recalled quotes are marked unavailable. Incomplete or unavailable quoted images are identified explicitly; quote chains are not recursively traversed.
- Group image requests still require an explicit mention of that Agent. Unmentioned group images stay on the Agent's host for later explicit quoting; they do not cause the entire group history to be uploaded. Recalling content after a model request cannot retract data already received by the model service. Bounded earlier text context is not a server-side erasure mechanism either.

### Manage sticker favorites

Click the **settings gear in the first cell of the sticker grid** to open the separate manager. The entry remains available when there are no favorites. Import local images, drag to reorder, use move buttons or Alt + Left/Right, select all and batch-delete. Order is saved automatically, synchronized to the sending panel and retained when reopened. Right-clicking a favorite no longer deletes it.

Deletion requires confirmation and **removes only the favorite index—not chat history or local assets that historical/in-flight messages may still reference**. This is not disk cleanup or secure erasure. There is no store, cloud synchronization or external download.

### Gomoku and Chinese chess

In a direct or group conversation, choose **Gomoku** or **Chinese chess** from **PK**. The creator opens an independent board; recipients click an invitation card to join. Opening the same game from PK in the same conversation reuses an existing active room. At least one online peer with board-game support is required. Older clients are never forced to open a window.

- Join as a spectator, then choose a black/white or red/black seat. Once both seats are occupied, either seated player clicks **Start game**. Spectators cannot start it. Full rooms accept spectators only, who cannot move. Access is limited to the original direct-message peers or current group members.
- Gomoku: 15×15, no forbidden moves, five or more in a row wins. Xiangqi validates horse legs, elephant eyes, river/palace boundaries, cannon screens, facing generals and self-check. Checkmate and stalemate both lose. Threefold repetition with the same side to move draws; tournament perpetual-check/chase adjudication is not implemented.
- Leaving a seat or closing the board during play asks for confirmation and counts as resignation. Wins, draws and resignations open a result dialog. Both players must choose **Play again** to restart; **End** closes only your own board. Spectators can wait for the next game or leave without affecting other members.
- The host arbitrates seats and moves. The main process checks stale/replayed requests, seat races and spectator permissions. Rooms end when the host quits or is declared offline; host migration is not supported. Rooms expire after two hours, with at most 32 retained rooms per client.
- Invitations stay in chat history but must pass live-room and membership checks when reopened; ended rooms cannot be restored. Existing dice and rock–paper–scissors PK remain unchanged.

### Message Markdown rendering

Message bodies support bold, italic, strikethrough, headings, lists, quotes, inline/fenced code, simple tables and HTTP(S) links without switching editing modes. Literal `\n` in Agent prose is displayed as a newline; code and Windows paths keep their literal contents. Ordinary messages do not receive this escape conversion. Stored, copied and forwarded messages retain the original text.

This is a limited Markdown subset: HTML/scripts are never executed and remote message images are never loaded (Markdown images show their description only). Code and wide tables scroll inside the message. Links use the existing controlled opening path. Board invitations are dedicated cards showing the inviter, game and room; click **Join game / Spectate** to enter.

Developer validation: run `npm run build`, then `npm run test:extensions`. The script launches three isolated Electron clients and uses loopback networking only to verify real wins, rematches, spectators, invitation cards, avatars, the Agent form, Markdown through a local model mock and the production SDK/Agent/P2P path, pasted captioned images, image quotes, sticker drag/keyboard ordering, reopen persistence, cross-window synchronization and confirmed/batch deletion (confirmation responses are supplied by the isolated test). Screenshots and results are saved under `out/extension-ui-*`; no real model service is called.
