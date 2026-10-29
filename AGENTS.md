# Kadr for Codex

This is a fork of [HelpFreedom/kadr](https://github.com/HelpFreedom/kadr), an
Electron + React + TypeScript video editor. Preserve the upstream editing,
GPU preview, audio, Remotion and 3D functionality, credits and GPL-3.0 license.
The fork's embedded assistant is **Codex CLI**, connected to the live editor
over MCP. Development of the application and editing a user's video are
different tasks: `electron/skills/` describes the latter.

## Start here

- Use Node.js 22.12 or newer; Node.js 24 is the tested development runtime.
- `npm ci` installs the lockfile and rebuilds `node-pty` for Electron.
- `npm run verify` runs both TypeScript configurations, portable regression
  suites and the production build.
- `npm run test:media` adds FFmpeg-dependent audio/HDR checks.
- `npm run dev` starts the desktop app; it requires a display and system
  `ffmpeg`/`ffprobe` for media processing.
- Do not run authenticated model calls or paid ElevenLabs synthesis as tests.
  The portable checks use a fake editor/CLI and synthetic media.

Read [docs/codex.md](docs/codex.md) for installation and host boundaries. Read
only the relevant section of [docs/architecture.md](docs/architecture.md)
when changing the media engine. The full feature guide is [FEATURES.md](FEATURES.md).

## Code map

- `electron/agent.ts`: embedded PTY lifetime, serialized open/close and IPC.
- `electron/agentConfig.ts`: validated configuration, executable lookup and
  per-session Codex MCP launch arguments.
- `electron/agentSkills.ts`: synchronization of bundled skills to
  `~/.agents/skills`, respecting user-owned files.
- `electron/agentBridge.ts`: authenticated loopback-only editor bridge.
- `electron/agentSessions.ts`: verified Linux orphan-session ownership;
  `shared/agentContext.ts`: project/directory session binding.
- `electron/mcp-bridge.cjs`: MCP stdio tools and cross-tool instructions.
- `electron/main.ts` / `preload.ts`: native file/media IPC and context bridge.
- `shared/types.ts`: project model and typed IPC; times are seconds and
  track index 0 is the top video track.
- `src/state/store.ts`: immutable editor snapshots and undo history.
- `src/engine/`: preview, export, autosave and higher-level editing actions.
- `electron/ffmpeg.ts`: probing, proxies, reverse, audio mixdown and fallback
  raw-video encoding. Preserve rendered intermediates when muxing fails.
- `electron/skills/*.md`: composable live-editing skills; YAML must start on
  the first line. Preserve the Kadr managed marker.

## Integration boundaries

- Preserve the user's Codex login, selected model, `CODEX_HOME`, global
  configuration and approval/sandbox policy. Kadr supplies its own MCP
  connection for one session; it must not enable an approval bypass.
- Never put the bridge token into process arguments, logs or project files.
  Authenticate every evaluation request; bind only to `127.0.0.1` and reject
  browser-origin requests. This endpoint can mutate projects and access files.
- Closing an old session must not kill, clear or write into a newer session.
  A failed or superseded start must release its process and server.
- Local timeouts do not prove a mutation failed. Report uncertain completion
  and read the live state before retrying.
- Keep upstream authorship. Historical `claude:*` IPC channels and CSS hooks
  may remain as compatibility identifiers; they do not select the agent.

## Validation

Add focused regression coverage for lifecycle, permission, data-loss and
transport changes. Verify actual failure behaviour instead of asserting only
implementation strings. Keep tests offline and independent of user profiles.
For desktop/CDP suites, use disposable `KADR_USER_DATA` and `KADR_AGENT_SKILLS_DIR` directories
and a blank project;
some older suites replace the timeline. Use `KADR_TTS_MOCK=1` for voice suites.
Do not describe a build or mocked MCP test as a live GPU export, macOS test or
authenticated Codex session. Record exactly what ran and what needs a desktop.
