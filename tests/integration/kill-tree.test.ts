import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { killTree } from "../../src/process/kill-tree.ts";
import { FAKE_CLAUDE, isAlive, waitForDeath } from "../helpers/process.ts";

const win32 = process.platform === "win32";

const leftovers: number[] = [];
afterEach(() => {
  for (const pid of leftovers.splice(0)) {
    try {
      process.kill(pid);
    } catch {}
  }
});

function spawnFake(scenario: string) {
  const child = spawn(process.execPath, [FAKE_CLAUDE], {
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", FAKE_CLAUDE_SCENARIO: scenario },
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
    detached: !win32, // its own process group, as the runner spawns it
  });
  if (child.pid === undefined) throw new Error("spawn failed");
  leftovers.push(child.pid);
  return { child, pid: child.pid };
}

async function firstLine(
  child: ReturnType<typeof spawnFake>["child"],
): Promise<Record<string, number>> {
  if (!child.stdout) throw new Error("no stdout");
  for await (const line of createInterface({ input: child.stdout })) {
    return JSON.parse(line) as Record<string, number>;
  }
  throw new Error("no output");
}

async function grandchildOf(child: ReturnType<typeof spawnFake>["child"]): Promise<number> {
  const pid = (await firstLine(child)).pid as number;
  leftovers.push(pid);
  return pid;
}

describe("killTree", () => {
  it("kills a process and its grandchildren", async () => {
    const { child, pid } = spawnFake("grandchild");
    const grandchildPid = await grandchildOf(child);
    expect(isAlive(grandchildPid)).toBe(true);

    await killTree(pid);

    await waitForDeath(pid);
    await waitForDeath(grandchildPid);
  }, 20_000);

  it("is needed: killing only the parent leaves the grandchild running", async () => {
    const { child, pid } = spawnFake("grandchild");
    const grandchildPid = await grandchildOf(child);
    process.kill(pid);
    await waitForDeath(pid);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(grandchildPid)).toBe(true);
  }, 20_000);

  it.runIf(!win32)(
    "sends SIGTERM first, so the process can exit cleanly",
    async () => {
      const { child, pid } = spawnFake("exit-on-sigterm");
      await firstLine(child); // its SIGTERM handler is installed
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      await killTree(pid);
      expect(await exited).toBe(0);
    },
    20_000,
  );

  it.runIf(!win32)(
    "escalates to SIGKILL when the process ignores SIGTERM",
    async () => {
      const { child, pid } = spawnFake("ignore-sigterm");
      await firstLine(child); // its SIGTERM handler is installed
      await killTree(pid);
      await waitForDeath(pid);
    },
    20_000,
  );

  it("resolves for a process that has already exited", async () => {
    const { child, pid } = spawnFake("lines");
    await new Promise((resolve) => child.once("exit", resolve));
    await waitForDeath(pid);
    await expect(killTree(pid)).resolves.toBeUndefined();
  }, 20_000);
});
