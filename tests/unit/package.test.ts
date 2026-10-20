import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../helpers/server.ts";

interface PackageJson {
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  os?: string[];
  engines?: { node?: string };
  scripts?: Record<string, string>;
  publishConfig?: { access?: string };
  keywords?: string[];
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as PackageJson;

describe("package.json (what npm publishes)", () => {
  it("can be published", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.keywords).toEqual(expect.arrayContaining(["claude", "claude-code"]));
  });

  it("installs a claude-loopback command built from src/cli.ts", () => {
    expect(pkg.bin).toEqual({ "claude-loopback": "dist/cli.js" });
    const source = path.join(ROOT, "src", "cli.ts");
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(source, "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  it("ships only the build, the settings template and the API description", () => {
    expect(pkg.files).toEqual(["dist", "!dist/**/*.map", ".env.example", "docs/openapi.json"]);
  });

  it("installs on Windows, macOS and Linux with Node 24 or newer", () => {
    expect(pkg.os).toBeUndefined();
    expect(pkg.keywords).toEqual(expect.arrayContaining(["windows", "macos", "linux"]));
    expect(pkg.engines?.node).toBe(">=24");
  });

  it("builds before packing and checks before publishing", () => {
    expect(pkg.scripts?.prepack).toBe("pnpm run build");
    expect(pkg.scripts?.prepublishOnly).toBe("pnpm run check");
  });
});
