import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acquireInstanceLock } from "../../src/process/instance-lock.ts";
import { StartupError } from "../../src/startup-error.ts";
import { scratchRoot, waitForDeath } from "../helpers/process.ts";

const win32 = process.platform === "win32";
const darwin = process.platform === "darwin";
/** Windows and Linux lock a machine-wide name (a pipe, an abstract socket); macOS locks a file. */
const named = !darwin;

const workRoot = () => path.join(scratchRoot(), "work");
/** On macOS the lock is a file beside the work root, in its own private directory. */
const lockDir = (root: string) => `${path.resolve(root)}.lock`;
const lockFileOf = (root: string) => path.join(lockDir(root), "lock");

const hashOf = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 32);
/** The lock name for a hash: a named pipe on Windows, an abstract socket on Linux. */
const nameFor = (hash: string) =>
  win32 ? `\\\\.\\pipe\\loopback-${hash}` : `\0claude-loopback-${hash}`;
/** The work root's part of the name's key (Windows paths are case-insensitive, so lower-cased). */
const keyOf = (root: string) => (win32 ? path.resolve(root).toLowerCase() : path.resolve(root));
/**
 * Where the lock for `root` listens, computed from first principles: the pipe name hashes the
 * path and the salt, the abstract name the salt alone.
 */
const lockName = (root: string, salt: string) =>
  nameFor(hashOf(win32 ? `${keyOf(root)}|${salt}` : salt));
const HOLDER = fileURLToPath(new URL("../fixtures/lock-holder.ts", import.meta.url));

async function refused(promise: Promise<unknown>): Promise<StartupError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StartupError);
  return error as StartupError;
}

/** Holds the lock for `root` in another process until killed. */
async function holderOf(root: string) {
  const holder = spawn(process.execPath, [HOLDER, root], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  await once(holder.stdout as NodeJS.ReadableStream, "data");
  return holder;
}

// Uses real pipes, sockets and child processes, which can be slow on a busy machine.
describe("acquireInstanceLock", { timeout: 20_000 }, () => {
  it("refuses a second holder for the same work root", async () => {
    const root = workRoot();
    const lock = await acquireInstanceLock(root);
    try {
      expect((await refused(acquireInstanceLock(root))).message).toContain("already running");
    } finally {
      await lock.release();
    }
  });

  it("can be taken again after release", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    await (await acquireInstanceLock(root)).release();
  });

  it.runIf(win32)(
    "treats paths that differ only in case or form as the same work root",
    async () => {
      const root = workRoot();
      const lock = await acquireInstanceLock(root);
      try {
        await refused(acquireInstanceLock(root.toUpperCase()));
        await refused(acquireInstanceLock(path.join(root, "..", path.basename(root))));
      } finally {
        await lock.release();
      }
    },
  );

  it.runIf(!win32)("treats paths that differ only in form as the same work root", async () => {
    const root = workRoot();
    const lock = await acquireInstanceLock(root);
    try {
      await refused(acquireInstanceLock(path.join(root, "..", path.basename(root))));
    } finally {
      await lock.release();
    }
  });

  it.runIf(!win32)(
    "treats case aliases as the same work root where the filesystem does",
    async () => {
      const root = workRoot();
      mkdirSync(root);
      const alias = path.join(path.dirname(root), path.basename(root).toUpperCase());
      const lock = await acquireInstanceLock(root);
      try {
        // On a case-folding filesystem (macOS) the alias names the same directory; elsewhere it
        // is a different work root.
        if (existsSync(alias)) await refused(acquireInstanceLock(alias));
        else await (await acquireInstanceLock(alias)).release();
      } finally {
        await lock.release();
      }
    },
  );

  it.runIf(!win32)("treats a symlink to the work root as the same work root", async () => {
    const root = workRoot();
    mkdirSync(root);
    const alias = path.join(scratchRoot(), "alias");
    symlinkSync(root, alias, "dir");
    const lock = await acquireInstanceLock(alias);
    try {
      await refused(acquireInstanceLock(root));
    } finally {
      await lock.release();
    }
  });

  it.runIf(!win32)("refuses a work root that is a symlink to a missing path", async () => {
    // Until the target exists the alias would get a lock of its own, and share the work dir with
    // the target's lock holder once it does.
    const alias = path.join(scratchRoot(), "alias");
    symlinkSync(path.join(scratchRoot(), "missing"), alias, "dir");
    expect((await refused(acquireInstanceLock(alias))).message).toContain("does not exist");
  });

  it("does not conflict across different work roots", async () => {
    const a = await acquireInstanceLock(workRoot());
    const b = await acquireInstanceLock(workRoot());
    await a.release();
    await b.release();
  });

  it.runIf(named)(
    "can't be blocked by another program taking a lock name derived from the path alone",
    async () => {
      const root = workRoot();
      const squatter = createServer();
      await new Promise<void>((resolve) => squatter.listen(nameFor(hashOf(keyOf(root))), resolve));
      try {
        await (await acquireInstanceLock(root)).release();
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    },
  );

  it.runIf(named)(
    "refuses to start when another program squats the current lock name",
    async () => {
      const root = workRoot();
      await (await acquireInstanceLock(root)).release(); // creates the salt
      const saltFile = `${path.resolve(root)}.lock-salt`;
      const salt = readFileSync(saltFile, "utf8").trim();
      // A squatter (the name shows in pipe and socket listings) accepts connections but can't
      // answer the challenge without the salt.
      const squatter = createServer((socket) => socket.on("data", () => socket.end("nope")));
      await new Promise<void>((resolve) => squatter.listen(lockName(root, salt), resolve));
      try {
        // Moving to a fresh name instead could put a simultaneous starter on a name of its own:
        // two instances for one work root. The user is told which file to delete for a new name,
        // and to stop every instance first: a deletion while one runs has the same effect.
        const message = (await refused(acquireInstanceLock(root))).message;
        expect(message).toContain(saltFile);
        expect(message).toContain("stop every claude-loopback instance");
        expect(readFileSync(saltFile, "utf8").trim()).toBe(salt);
      } finally {
        await new Promise<void>((resolve) => squatter.close(() => resolve()));
      }
    },
  );

  it.runIf(named)(
    "retries when the holder hangs up without answering (a pipe closing behind its dead owner)",
    async () => {
      const root = workRoot();
      await (await acquireInstanceLock(root)).release();
      const salt = readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim();
      // On Windows a dead owner's pipe can still accept a connection and then drop it.
      const closing = createServer((socket) => {
        socket.destroy();
        closing.close();
      });
      await new Promise<void>((resolve) => closing.listen(lockName(root, salt), resolve));
      await (await acquireInstanceLock(root)).release();
    },
  );

  it.runIf(named)(
    "refuses to start when the holder doesn't answer: it may be a stalled instance",
    async () => {
      const root = workRoot();
      await (await acquireInstanceLock(root)).release();
      const salt = readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim();
      const sockets: Socket[] = [];
      // Accepts, never replies (like a paused process).
      const silent = createServer((socket) => sockets.push(socket));
      await new Promise<void>((resolve) => silent.listen(lockName(root, salt), resolve));
      try {
        expect((await refused(acquireInstanceLock(root))).message).toContain("not responding");
        expect(readFileSync(`${path.resolve(root)}.lock-salt`, "utf8").trim()).toBe(salt);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => silent.close(() => resolve()));
      }
    },
    40_000,
  );

  it.runIf(!win32)("refuses to start while the holder is stopped", async () => {
    const root = workRoot();
    const holder = await holderOf(root);
    try {
      // A stopped instance still owns its work dirs: it must be refused, never taken over.
      holder.kill("SIGSTOP");
      await refused(acquireInstanceLock(root));
    } finally {
      holder.kill("SIGKILL");
    }
  });

  it("keeps the same lock across restarts and processes", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    const holder = await holderOf(root);
    try {
      await refused(acquireInstanceLock(root));
    } finally {
      holder.kill();
    }
  });

  it("serialises simultaneous attempts: exactly one wins", async () => {
    const root = workRoot();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => acquireInstanceLock(root)),
    );
    const winners = results.filter((result) => result.status === "fulfilled");
    expect(winners).toHaveLength(1);
    await (winners[0] as PromiseFulfilledResult<{ release(): Promise<void> }>).value.release();
  });

  it("is freed by the OS when the holder is killed without cleaning up", async () => {
    const root = workRoot();
    const holder = await holderOf(root);
    try {
      await refused(acquireInstanceLock(root));
      holder.kill("SIGKILL"); // TerminateProcess on Windows: no cleanup code runs
      await waitForDeath(holder.pid as number);
      await (await acquireInstanceLock(root)).release();
    } finally {
      holder.kill();
    }
  });

  it.runIf(process.platform === "linux")("keeps the salt readable only by its owner", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    expect(statSync(`${path.resolve(root)}.lock-salt`).mode & 0o077).toBe(0);
  });

  it.runIf(darwin)("keeps the lock file in a private directory beside the work root", async () => {
    const root = workRoot();
    const lock = await acquireInstanceLock(root);
    try {
      expect(existsSync(lockFileOf(root))).toBe(true);
      expect(statSync(lockDir(root)).mode & 0o077).toBe(0);
      // Not under the temp dir: the same work root must map to one lock whatever TMPDIR says.
      const saved = process.env.TMPDIR;
      process.env.TMPDIR = scratchRoot();
      try {
        await refused(acquireInstanceLock(root));
      } finally {
        if (saved === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = saved;
      }
    } finally {
      await lock.release();
    }
  });

  it.runIf(darwin)("leaves the lock file in place after release", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    // Removing it would let the next starter lock a different inode than a current holder's.
    expect(existsSync(lockFileOf(root))).toBe(true);
  });

  it.runIf(darwin)("refuses a lock directory that is not private", async () => {
    const root = workRoot();
    await (await acquireInstanceLock(root)).release();
    chmodSync(lockDir(root), 0o755);
    expect((await refused(acquireInstanceLock(root))).message).toContain("private");
  });
});
