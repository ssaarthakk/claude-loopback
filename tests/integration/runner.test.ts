import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.ts";
import { FakeClock } from "../helpers/app.ts";
import {
  collect,
  FAKE_CLAUDE,
  fakeSpec,
  isAlive,
  makeRunner,
  scratchRoot,
  waitForDeath,
} from "../helpers/process.ts";

const win32 = process.platform === "win32";

const T = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("process runner", () => {
  it(
    "runs the command in a fresh temp dir with exactly the given args, env and stdin",
    async () => {
      const { runner, workRoot } = makeRunner();
      const stdin = "héllo wörld ✓ — multibyte prompt";
      const run = await runner.start(fakeSpec("echo", { args: [FAKE_CLAUDE, "-p", "--x"], stdin }));
      const echoed = JSON.parse(await collect(run.stdout));
      const exit = await run.exit;

      expect(exit.code).toBe(0);
      expect(exit.killReason).toBeUndefined();
      expect(echoed.stdin).toBe(stdin);
      expect(echoed.argv).toEqual(["-p", "--x"]);
      expect(path.dirname(echoed.cwd)).toBe(workRoot);
      expect(path.basename(echoed.cwd)).toMatch(/^req-/);
      expect(echoed.envKeys).not.toContain("LOOPBACK_TOKEN");
      expect(echoed.envKeys).not.toContain("ANTHROPIC_API_KEY");
      expect(echoed.envKeys).toContain("FAKE_CLAUDE_SCENARIO");
    },
    T,
  );

  it(
    "uses a different directory for every run and removes it, files included",
    async () => {
      const { runner, workRoot } = makeRunner();
      const first = await runner.start(fakeSpec("echo"));
      const firstCwd = JSON.parse(await collect(first.stdout)).cwd;
      await first.exit;
      const second = await runner.start(fakeSpec("echo"));
      const secondCwd = JSON.parse(await collect(second.stdout)).cwd;
      await second.exit;

      expect(firstCwd).not.toBe(secondCwd);
      expect(existsSync(firstCwd)).toBe(false);
      expect(existsSync(secondCwd)).toBe(false);
      expect(readdirSync(workRoot)).toEqual([]);
    },
    T,
  );

  it(
    "reports a non-zero exit code and the stderr tail",
    async () => {
      const { runner } = makeRunner();
      const run = await runner.start(fakeSpec("fail"));
      await collect(run.stdout);
      const exit = await run.exit;
      expect(exit.code).toBe(3);
      expect(exit.killReason).toBeUndefined();
      expect(exit.stderrTail).toContain("something went wrong");
    },
    T,
  );

  it(
    "keeps only the end of a large stderr",
    async () => {
      const { runner } = makeRunner({ stderrTailBytes: 1024 });
      const run = await runner.start(fakeSpec("big-stderr"));
      await collect(run.stdout);
      const exit = await run.exit;
      expect(exit.stderrTail.length).toBeLessThanOrEqual(1024);
      expect(exit.stderrTail.endsWith("END-OF-STDERR")).toBe(true);
    },
    T,
  );

  it(
    "kills the process tree when the timeout elapses",
    async () => {
      const clock = new FakeClock();
      const { runner } = makeRunner({ clock });
      const run = await runner.start(fakeSpec("hang", { timeoutMs: 5000 }));
      clock.advance(4999);
      expect(isAlive(run.pid)).toBe(true);
      clock.advance(1);
      const exit = await run.exit;
      expect(exit.killReason).toBe("timeout");
      await waitForDeath(run.pid);
    },
    T,
  );

  it(
    "kills the process and its grandchildren when the signal aborts",
    async () => {
      const { runner } = makeRunner();
      const controller = new AbortController();
      const run = await runner.start(fakeSpec("grandchild", { signal: controller.signal }));
      const iterator = run.stdout[Symbol.asyncIterator]();
      const first = await iterator.next();
      const grandchildPid = (JSON.parse(String(first.value)) as { pid: number }).pid;
      try {
        controller.abort();
        const exit = await run.exit;
        expect(exit.killReason).toBe("aborted");
        await waitForDeath(run.pid);
        await waitForDeath(grandchildPid);
      } finally {
        if (isAlive(grandchildPid)) process.kill(grandchildPid);
      }
    },
    T,
  );

  it(
    "does not leave a process running when the signal is already aborted",
    async () => {
      const { runner } = makeRunner();
      const run = await runner.start(fakeSpec("hang", { signal: AbortSignal.abort() }));
      const exit = await run.exit;
      expect(exit.killReason).toBe("aborted");
      await waitForDeath(run.pid);
    },
    T,
  );

  it(
    "kills a process whose output exceeds the cap",
    async () => {
      const { runner } = makeRunner({ maxStdoutBytes: 256 * 1024 });
      const run = await runner.start(fakeSpec("flood"));
      const output = await collect(run.stdout);
      const exit = await run.exit;
      expect(exit.killReason).toBe("output_too_large");
      expect(output.length).toBeLessThanOrEqual(256 * 1024);
      await waitForDeath(run.pid);
    },
    T,
  );

  it(
    "keeps the first kill reason when killed more than once",
    async () => {
      const { runner } = makeRunner();
      const run = await runner.start(fakeSpec("hang"));
      await Promise.all([run.kill("timeout"), run.kill("aborted"), run.kill("timeout")]);
      expect((await run.exit).killReason).toBe("timeout");
    },
    T,
  );

  it(
    "kills the process when the consumer abandons stdout",
    async () => {
      const { runner } = makeRunner();
      const run = await runner.start(fakeSpec("grandchild", { timeoutMs: 60_000 }));
      let grandchildPid = 0;
      for await (const chunk of run.stdout) {
        grandchildPid = (JSON.parse(String(chunk)) as { pid: number }).pid;
        break;
      }
      try {
        const exit = await run.exit;
        expect(exit.killReason).toBe("aborted");
        expect(exit.durationMs).toBeLessThan(10_000);
        await waitForDeath(grandchildPid);
      } finally {
        if (isAlive(grandchildPid)) process.kill(grandchildPid);
      }
    },
    T,
  );

  it(
    "streams stdout as it is produced",
    async () => {
      const { runner } = makeRunner();
      const run = await runner.start(
        fakeSpec("lines", { env: { ...fakeSpec("lines").env, FAKE_CLAUDE_LINES: "50" } }),
      );
      const lines = (await collect(run.stdout)).trim().split("\n");
      expect(lines).toHaveLength(50);
      expect(JSON.parse(lines[49] ?? "")).toEqual({ type: "line", i: 49 });
      expect((await run.exit).code).toBe(0);
    },
    T,
  );

  it(
    "delivers everything to a slow consumer even after the process has exited",
    async () => {
      const { runner } = makeRunner({ closeGraceMs: 50 });
      const run = await runner.start(
        fakeSpec("lines", { env: { ...fakeSpec("lines").env, FAKE_CLAUDE_LINES: "3000" } }),
      );
      const iterator = run.stdout[Symbol.asyncIterator]();
      let output = String((await iterator.next()).value ?? "");
      await sleep(400);
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        output += String(next.value);
      }
      expect(output.trim().split("\n")).toHaveLength(3000);
      expect((await run.exit).code).toBe(0);
    },
    T,
  );

  it(
    "keeps buffered output for a consumer that only starts after exit",
    async () => {
      const { runner } = makeRunner({ closeGraceMs: 50 });
      const run = await runner.start(
        fakeSpec("lines", { env: { ...fakeSpec("lines").env, FAKE_CLAUDE_LINES: "3000" } }),
      );
      await run.exit;
      expect((await collect(run.stdout)).trim().split("\n")).toHaveLength(3000);
    },
    T,
  );

  it(
    "fails, rather than silently truncating, when unread output had to be cut off",
    async () => {
      const clock = new FakeClock();
      const { runner } = makeRunner({ clock, closeGraceMs: 50, stdoutBufferBytes: 16 * 1024 });
      const run = await runner.start(
        fakeSpec("lines", {
          env: { ...fakeSpec("lines").env, FAKE_CLAUDE_LINES: "100000" },
          timeoutMs: 5000,
        }),
      );
      await sleep(300); // let the child fill the buffer and block on the pipe
      clock.advance(5000);
      expect((await run.exit).killReason).toBe("timeout");
      await expect(collect(run.stdout)).rejects.toThrow(/cut off/);
    },
    T,
  );

  it(
    "fails with cli_unavailable when the command cannot be started, leaving nothing behind",
    async () => {
      const { runner, workRoot } = makeRunner();
      const missing = path.join(workRoot, "..", "no-such-claude.exe");
      const error = await runner.start(fakeSpec("echo", { command: missing })).catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("cli_unavailable");
      expect(existsSync(workRoot) ? readdirSync(workRoot) : []).toEqual([]);
    },
    T,
  );

  it(
    "kills every active run's whole tree synchronously, for a forced exit",
    async () => {
      const { runner } = makeRunner();
      const first = await runner.start(fakeSpec("grandchild"));
      const second = await runner.start(fakeSpec("hang"));
      const grandchildPid = (
        JSON.parse(String((await first.stdout[Symbol.asyncIterator]().next()).value)) as {
          pid: number;
        }
      ).pid;
      try {
        runner.killAllSync();
        // Synchronous: by the time it returns, taskkill has finished with every tree.
        await waitForDeath(first.pid, 2000);
        await waitForDeath(second.pid, 2000);
        await waitForDeath(grandchildPid, 2000);
        await Promise.all([first.exit, second.exit]);
      } finally {
        if (isAlive(grandchildPid)) process.kill(grandchildPid);
      }
    },
    T,
  );

  it.runIf(win32)(
    "takes the child down with the server if the server process dies",
    async () => {
      const host = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../fixtures/runner-host.ts", import.meta.url)),
          path.join(scratchRoot(), "work"),
        ],
        { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
      );
      if (!host.stdout || host.pid === undefined) throw new Error("spawn failed");
      let childPid = 0;
      for await (const line of createInterface({ input: host.stdout })) {
        childPid = (JSON.parse(line) as { childPid: number }).childPid;
        break;
      }
      try {
        expect(isAlive(childPid)).toBe(true);
        process.kill(host.pid); // TerminateProcess: no tree kill, no cleanup code runs
        await waitForDeath(host.pid);
        await waitForDeath(childPid);
      } finally {
        if (isAlive(childPid)) process.kill(childPid);
      }
    },
    T,
  );
});
