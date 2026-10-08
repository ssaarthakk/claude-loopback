import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StartupError } from "../startup-error.ts";

const WIN32 = process.platform === "win32";
const DARWIN = process.platform === "darwin";
// <sys/fcntl.h>: O_EXLOCK, "atomically obtain an exclusive lock" (flock) at open. Not in
// fs.constants; macOS only.
const O_EXLOCK = 0x20;
const BUSY_RETRIES = 5;
const BUSY_RETRY_MS = 250;
const CHALLENGE_BYTES = 32;
const CHALLENGE_TIMEOUT_MS = 2000;
const BUSY_ANSWER_ATTEMPTS = 2;

export interface InstanceLock {
  release(): Promise<void>;
}

const SALT = /^[0-9a-f]{64}$/;
const SALT_READ_RETRIES = 20;
const SALT_READ_RETRY_MS = 25;

const saltFile = (workRoot: string) => `${path.resolve(workRoot)}.lock-salt`;

/**
 * A random value kept beside the work root (`<workRoot>.lock-salt`, in the same per-user private
 * folder, and not inside it, so the work root holds only work dirs). Pipe names (and abstract
 * socket names) are machine-wide, so a name derived from the path alone could be created first
 * by another local user to block startup. With the salt, only processes that can read that
 * folder know the name, and only they can answer the lock's challenge. The file is owner-only
 * (0600, where modes apply): on Linux the folder may be a shared temp dir, and the salt is the
 * lock's one secret.
 */
async function readSalt(workRoot: string): Promise<string> {
  const file = saltFile(workRoot);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // A simultaneous starter may have created the file but not written it yet.
  for (let attempt = 1; ; attempt++) {
    const value = (await readFile(file, "utf8")).trim();
    if (SALT.test(value)) return value;
    if (attempt >= SALT_READ_RETRIES) {
      throw new StartupError(`The instance lock file ${file} is damaged; delete it and retry`);
    }
    await delay(SALT_READ_RETRY_MS);
  }
}

/** One pipe name per work root and salt; Windows paths are case-insensitive, so the key is too. */
function pipeName(workRoot: string, salt: string): string {
  const key = `${path.resolve(workRoot).toLowerCase()}|${salt}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\loopback-${hash}`;
}

/**
 * Linux: one abstract socket name per salt. The salt is already one per work root (its file sits
 * beside the root), so the path adds nothing to the key and would only give bind-mount aliases
 * of the root's parent separate locks. Like the pipe name it is machine-wide, visible to and
 * takeable by any user (hence the salt and the challenge); unlike a socket file it leaves
 * nothing behind when its holder dies. macOS has no abstract namespace.
 */
function abstractName(salt: string): string {
  const hash = createHash("sha256").update(salt).digest("hex").slice(0, 32);
  return `\0claude-loopback-${hash}`;
}

/**
 * The work root as the filesystem knows it, so that a symlink to it names the same lock. A root
 * that does not exist yet cannot be a symlink itself; its parent (created here, as the salt needs
 * it anyway) is resolved instead.
 */
async function canonicalRoot(workRoot: string): Promise<string> {
  const resolved = path.resolve(workRoot);
  await mkdir(path.dirname(resolved), { recursive: true });
  try {
    return await realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // ENOENT is also what a symlink to a missing target gives. Such a root would get a lock of
  // its own and, once the target exists, share the work dir with the target's lock holder.
  if (
    await lstat(resolved).then(
      () => true,
      () => false,
    )
  ) {
    throw new StartupError(`The work root ${resolved} is a symlink to a path that does not exist`);
  }
  return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
}

/**
 * `<workRoot>.lock`, the directory holding the macOS lock file: 0700, ours, a real directory
 * and not a symlink, so nobody else can place or replace the file.
 */
async function lockDir(workRoot: string): Promise<string> {
  const dir = `${workRoot}.lock`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new StartupError(
      `The instance lock directory ${dir} must be a private directory (mode 0700) owned by you`,
    );
  }
  return dir;
}

/**
 * macOS: the lock is an exclusive kernel lock (flock) on `<workRoot>.lock/lock`, taken by the
 * open itself (O_EXLOCK, non-blocking), so there is no check-then-lock gap, and released when the
 * process dies, however it dies. The file is created once and never removed: unlinking it would
 * let the next starter lock a new inode while the holder keeps the old one. A held lock does not
 * say who holds it, so the message names both possibilities.
 */
async function lockFile(workRoot: string): Promise<InstanceLock> {
  const file = path.join(await lockDir(workRoot), "lock");
  const flags = constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK;
  try {
    const handle = await open(file, flags, 0o600);
    return { release: () => handle.close() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    throw new StartupError(
      `Another claude-loopback instance is already running for ${workRoot} ` +
        `(or another program holds ${file})`,
    );
  }
}

const answer = (salt: string, nonce: Buffer) => createHmac("sha256", salt).update(nonce).digest();

/** The lock's pipe server: answers each connection's nonce with HMAC(salt, nonce), then hangs up. */
function lockServer(salt: string): Server {
  return createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.setTimeout(CHALLENGE_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= CHALLENGE_BYTES) {
        socket.end(answer(salt, received.subarray(0, CHALLENGE_BYTES)));
      }
    });
  });
}

type Holder = "genuine" | "impostor" | "busy" | "gone";

/**
 * Who holds the pipe: "genuine" (another claude-loopback with the same salt), "impostor" (a
 * program that answers wrongly), "busy" (no answer in time: maybe a stalled instance, so never
 * treated as an impostor) or "gone" (the pipe vanished or hung up without a word, e.g. its
 * owner just exited).
 */
function challenge(name: string, salt: string): Promise<Holder> {
  return new Promise((resolve) => {
    const nonce = randomBytes(CHALLENGE_BYTES);
    const expected = answer(salt, nonce);
    let received = Buffer.alloc(0);
    const socket = connect(name);
    const finish = (verdict: Holder) => {
      socket.destroy();
      resolve(verdict);
    };
    // A Windows pipe closing behind its dead owner can accept the connection and then drop it.
    // Calling that an impostor would refuse a start that a retry lets through, so only a wrong
    // answer is one.
    const hungUp = () => finish(received.length > 0 ? "impostor" : "gone");
    socket.setTimeout(CHALLENGE_TIMEOUT_MS, () => finish("busy"));
    socket.on("connect", () => socket.write(nonce));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= expected.length) {
        const reply = received.subarray(0, expected.length);
        finish(timingSafeEqual(reply, expected) ? "genuine" : "impostor");
      }
    });
    socket.on("end", hungUp);
    socket.on("error", hungUp);
  });
}

/**
 * One server per work root: a second instance's startup sweep would delete the first one's
 * active work dirs. The lock is a listening named pipe (an abstract unix socket on Linux), so
 * the kernel guarantees a single owner (no check-then-create race) and frees it when the process
 * dies, however it dies, so there are no stale locks or PID-reuse problems. When the name is
 * taken, a challenge tells another claude-loopback from a squatter; both mean refusing to start,
 * the squatter with the salt file named: deleting it, once every instance for the work root is
 * stopped, gives the lock a new name. macOS has no abstract namespace, and a socket file would
 * outlive a dead holder with no safe way to tell it from a stalled one, so there the lock is a
 * kernel file lock (see lockFile), which needs neither a name nor a challenge. Abstract names
 * are per network namespace: two instances in separate namespaces that share a home directory
 * (some container setups) do not see each other.
 */
export async function acquireInstanceLock(workRoot: string): Promise<InstanceLock> {
  const root = WIN32 ? workRoot : await canonicalRoot(workRoot);
  if (DARWIN) return lockFile(root);
  const salt = await readSalt(root);
  for (let attempt = 1; ; attempt++) {
    const name = WIN32 ? pipeName(root, salt) : abstractName(salt);
    const server = lockServer(salt);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(name, resolve);
      });
      server.unref(); // the lock alone never keeps the process alive
      return {
        release: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      const holder = await challenge(name, salt);
      if (holder === "genuine") {
        throw new StartupError(
          `Another claude-loopback instance is already running for ${path.resolve(root)}`,
        );
      }
      // Moving to a fresh salt here used to be automatic. Two starters that both found the name
      // squatted could each move to a salt of their own and both start, so the user does it.
      if (holder === "impostor") {
        throw new StartupError(
          `The instance lock name for ${path.resolve(root)} is held by a program that failed ` +
            "the lock's challenge; stop every claude-loopback instance for this work root " +
            `before deleting ${saltFile(root)} for a new name, then retry`,
        );
      }
      // No answer twice in a row: maybe a stalled instance. Starting anyway could delete its
      // work dirs, so refuse.
      if (holder === "busy" && attempt >= BUSY_ANSWER_ATTEMPTS) {
        throw new StartupError(
          `Another claude-loopback instance seems to be running for ${path.resolve(root)} ` +
            "but is not responding; stop it (or the program holding its lock) and retry",
        );
      }
      // A pipe outlives its dead owner for a moment while Windows closes the handles.
      if (attempt >= BUSY_RETRIES) {
        throw new StartupError(
          `Could not take the instance lock for ${path.resolve(root)}; another program may be holding it`,
        );
      }
      await delay(BUSY_RETRY_MS);
    }
  }
}
