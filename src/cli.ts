#!/usr/bin/env node
// The `claude-loopback` command installed by npm. Settings live in a per-user file
// (%APPDATA%\claude-loopback\config.env on Windows, ~/.config/claude-loopback/config.env
// elsewhere), never in the current folder, so running it inside some other project can't pick
// up that project's .env.
import { existsSync, readFileSync } from "node:fs";
import { styleText } from "node:util";
import type { Style } from "./banner.ts";
import { scrubSecrets } from "./config.ts";
import { docsUrl, formatDocs } from "./docs.ts";
import { runServer } from "./run.ts";
import { defaultSettingsFile, readSettings, runSetup } from "./setup.ts";
import { ensureTokenFile } from "./token-file.ts";
import { packageVersion } from "./version.ts";

type Format = Parameters<typeof styleText>[0];

const MIN_NODE_MAJOR = 24;
const WIN32 = process.platform === "win32";
/** How this platform's shell loads the token for a script: PowerShell, else bash or zsh. */
const TOKEN_HINT = WIN32
  ? "$env:LOOPBACK_TOKEN = (claude-loopback token)"
  : 'export LOOPBACK_TOKEN="$(claude-loopback token)"';

const file = (() => {
  try {
    return defaultSettingsFile(process.env);
  } catch (error) {
    return fail((error as Error).message);
  }
})();
const exampleFile = new URL("../.env.example", import.meta.url);

const usage = `Usage: claude-loopback [command]

Commands:
  start    Start the server (the default). Creates your settings on first run.
  setup    Create your settings if needed and check this machine (Node, Claude Code, login)
  token    Print your token, e.g. ${TOKEN_HINT}
  config   Print where your settings file is (edit it to change settings)
  docs     Print a quick API reference: routes, fields, errors and examples

Options:
  -v, --version   Print the version
  -h, --help      Print this help

Settings: ${file}`;

function fail(message: string): never {
  console.error(styleText("red", `claude-loopback: ${message}`, { stream: process.stderr }));
  process.exit(1);
}

const template = () =>
  existsSync(exampleFile) ? readFileSync(exampleFile, "utf8") : "LOOPBACK_TOKEN=\n";

/**
 * Creates the settings file with a new token if needed, and says so through `notice` (stderr
 * for `token`, whose stdout must be the token alone).
 */
async function ensureSettings(notice: (line: string) => void): Promise<void> {
  const result = await ensureTokenFile(file, template()).catch((error: NodeJS.ErrnoException) =>
    fail(`could not write ${file} (${error.code ?? "error"})`),
  );
  if (result.outcome === "created") {
    notice(`Created your settings with a new random token: ${file}`);
  } else if (result.outcome !== "kept") {
    notice(`Put a new random token in ${file}`);
  }
  if (!result.restricted) {
    console.error(`claude-loopback: warning: could not limit who can read ${file}`);
  }
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  fail(`needs Node.js ${MIN_NODE_MAJOR} or newer (this is ${process.versions.node})`);
}

const [command = "start", ...extra] = process.argv.slice(2);
if (extra.length > 0) fail(`unexpected argument "${extra[0]}"\n\n${usage}`);

switch (command) {
  case "start": {
    await ensureSettings(console.log);
    // Real environment variables override the file. Secrets leave process.env before anything
    // can spawn; the server works from this snapshot.
    const env = readSettings(file, process.env);
    scrubSecrets(process.env);
    await runServer(env, { configFile: file });
    break;
  }
  case "setup": {
    const problems = await runSetup({
      file,
      template: template(),
      label: file,
      rerun: "claude-loopback setup",
      next: "claude-loopback",
      env: process.env,
    });
    process.exit(problems === 0 ? 0 : 1);
    break;
  }
  case "token": {
    await ensureSettings(console.error);
    console.log(readSettings(file, process.env).LOOPBACK_TOKEN ?? "");
    break;
  }
  case "config":
    console.log(file);
    break;
  case "docs": {
    // Reads the settings only for the port; never creates them, never prints the token.
    let settings: Record<string, string | undefined> = process.env;
    try {
      if (existsSync(file)) settings = readSettings(file, process.env);
    } catch (error) {
      console.error(
        `claude-loopback: warning: could not read ${file} (${(error as NodeJS.ErrnoException).code ?? "error"}); showing the default port`,
      );
    }
    const style: Style = (format, text) =>
      styleText(format as Format, text, { stream: process.stdout });
    console.log(
      formatDocs(
        {
          version: packageVersion(),
          url: docsUrl(settings),
          shell: WIN32 ? "powershell" : "sh",
          settingsFile: file,
        },
        style,
      ),
    );
    break;
  }
  case "-v":
  case "--version":
    console.log(packageVersion());
    break;
  case "-h":
  case "--help":
  case "help":
    console.log(usage);
    break;
  default:
    fail(`unknown command "${command}"\n\n${usage}`);
}
