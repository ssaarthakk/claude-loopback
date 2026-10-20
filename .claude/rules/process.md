---
paths:
  - "src/backends/**"
  - "src/process/**"
---

# Spawning the claude CLI

- `spawn` with `shell: false` and an argument array. Never build a command string.
- Resolve `claude` to a real `.exe` on Windows, and to an executable file with symlinks resolved
  elsewhere. Never spawn `.cmd`/`.bat` shims: Node refuses them without a shell (EINVAL), and
  adding a shell reintroduces injection risk.
- Pass the prompt on stdin, not argv (argv has a length cap and is visible in process listings).
- Child env is an **allowlist** built from scratch, never `{ ...process.env }`. It must never
  contain `ANTHROPIC_API_KEY` or `LOOPBACK_TOKEN`.
- `cwd` is a fresh temp dir per request (`fs.mkdtemp` under `os.tmpdir()`), removed afterwards,
  with removal errors logged and not thrown. Never the repo or the home dir.
- Kill the whole tree: `taskkill /PID <pid> /T /F` on Windows (no process groups there), SIGTERM
  then SIGKILL to the child's own process group elsewhere (the runner spawns it `detached`).
  `child.kill()` alone leaves grandchildren running. Kill on timeout, client disconnect and
  shutdown.
- Set `windowsHide: true` so no console windows flash.
- Cap buffered stdout/stderr. Never forward raw stderr or file paths to clients.
- Verify every CLI flag against `claude --help` for the installed version, not memory.
- Isolation flags are mandatory: `--tools "" --permission-mode dontAsk --permission-prompts none
  --no-session-persistence --safe-mode --restricted --setting-sources "" --strict-mcp-config
  --disable-slash-commands`. `--safe-mode` alone still loads user plugins.
- When the CLI's output format is in question, capture a real run (with the user's OK, since
  it spends usage), redact it into `tests/fixtures/streams/`, and test against that.
