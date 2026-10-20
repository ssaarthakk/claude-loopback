# claude-loopback

A personal, localhost-only HTTP server that runs prompts through `claude -p` (Claude Code
headless mode) and returns JSON or streams SSE. Only for the owner's local scripts. Never
public, never multi-user, not a Messages API clone.

## Status & workflow
- Work in small, complete features. Stop for approval at the end of each one.
- **Platforms: Windows, macOS and Linux.** Keep OS-specific code behind a small seam (a
  `process.platform === "win32"` branch with its POSIX sibling beside it).

## Stack
Node 24 · TypeScript (strict) · Hono + @hono/node-server · Zod · Vitest · Biome · pnpm

## Commands
- `pnpm run check`: lint + typecheck + test (the gate; must pass before any commit)
- `pnpm run lint` / `pnpm run format`: Biome check / Biome check --write
- `pnpm run typecheck`: `tsc --noEmit` (also type-checks the `.mjs` hook scripts)
- `pnpm run test` / `pnpm run test:coverage`: Vitest once / with the 85%/80% coverage gate (CI)
- `pnpm run openapi`: regenerate `docs/openapi.json` after any API change (a test checks drift)
- `pnpm run e2e`: manual smoke test against a running server and the REAL CLI. Spends usage,
  so ask before running it.
- `pnpm run dev`: `node --watch src/index.ts` (Node strips TS types natively; loads `.env`)
- `pnpm run build` / `pnpm start`: clean `tsc` build to `dist/` / run the build
- `node src/cli.ts <start|setup|token|config>`: the npm command from source. Publishing
  (`npm publish`) runs check, then build, via `prepublishOnly`/`prepack`; only `dist/`,
  `.env.example` and `docs/openapi.json` ship (see `files` in package.json).
- `pnpm run token`: print a new random `LOOPBACK_TOKEN`

Imports between `.ts` files use the `.ts` extension (rewritten to `.js` on build). Use only
erasable TS syntax: no enums, namespaces or constructor parameter properties.

## Architecture
routes → service (queue, limits) → `ClaudeBackend` interface → process runner. `CliBackend`
now, `ApiBackend` (BYOK) later; routes never know which one is active. Config, logger, clock,
backend and spawner are injected so every layer is testable alone.

- `src/config.ts`: Zod env schema → frozen `Config`. `src/errors.ts`: `AppError`, code → status.
- `src/logger.ts`: pino with redaction; JSON or pretty (`src/log-format.ts`, pino-pretty).
  `src/clock.ts`: injectable time.
- `src/app.ts`: `createApp(deps)` (Hono). `src/server.ts`: `startServer` (all wiring, startup
  checks, graceful close). `src/run.ts`: `runServer` (signals, startup errors, banner from
  `src/banner.ts`).
- Entry points: `src/cli.ts` is the npm `claude-loopback` command (settings in
  `%APPDATA%\claude-loopback\config.env`, or `~/.config/claude-loopback/config.env`);
  `src/index.ts` is `pnpm start`/`dev` from a clone (`.env`). `src/setup.ts`: setup checks for
  both; `src/token-file.ts` + `src/file-acl.ts`: token file written readable only by the
  current user.
- `src/http/`: middleware, schemas (Zod, also the OpenAPI source), routes, SSE, openapi.
- `src/service/`: prompt service (policy, attachments, run loop, drain), queue.
- `src/backends/`: `types.ts` + `cli/` (args, env, stream parser, classify, probe).
- `src/process/`: runner (buffered stdout, caps, timeout/abort), tree kill, temp dirs,
  instance lock (named pipe).

Dev tooling: `.claude/hooks/` (format on edit, commit-message check, stop gate),
`scripts/commit-format.mjs` (commit rules, shared with `.githooks/commit-msg`).

## Security invariants (never break these)
- Bind to 127.0.0.1 only. A bearer token (`LOOPBACK_TOKEN`) is required, and the server refuses
  to start without one.
- Spawn `claude` with `shell: false` in a fresh temp dir per request, never the repo or the home dir.
- Child env comes from an allowlist and never contains `ANTHROPIC_API_KEY` or `LOOPBACK_TOKEN`.
- Tools are default-deny. Requests may only narrow the server allowlist.
- No stack traces, paths or raw stderr in responses. No prompt/output contents in logs.
- Tests never call the real `claude` CLI. Use a fake spawner or a fake binary.
- Check CLI flags against `claude --help` for the installed version, not memory.

## Test-first (always)
1. Spec the behavior and edge cases, including failure paths.
2. Write tests against the public interface (exported functions, HTTP routes, runner API).
3. Add stubs with real signatures that `throw new Error("not implemented")`. Run the tests and
   confirm each new test fails on an assertion or that error, not on an import/typo. A test that
   passes before the code exists tests nothing, so fix or delete it.
4. Implement until green.
5. Never weaken, loosen or delete an assertion to make code pass. If a test was wrong, fix it and
   say so in the milestone summary.

## Commit policy (strict)
- One commit per completed feature or milestone, not per file or small edit.
- Commit only when `pnpm run check` passes. Never commit WIP or broken states.
- Fold formatting fixes, typo fixes and small follow-ups into the feature's commit.
- Don't commit unless a feature is complete or the user asks.
- Never bypass hooks (`--no-verify`, `-n`).

## Commit format (strict, enforced by hooks)
- Single line only, imperative mood, lowercase start, max 60 characters, no trailing period.
- No body, no description, no trailers, no Co-Authored-By lines.
- Examples: `add sse streaming endpoint`, `fix child kill on disconnect`
