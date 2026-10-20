import { z } from "zod";
import type { Style } from "./banner.ts";
import { DEFAULT_PORT } from "./config.ts";
import { ERROR_CODES, type ErrorStatus, errorStatus } from "./errors.ts";
import { buildOpenApiDocument } from "./http/openapi.ts";
import {
  promptRequest,
  promptResponse,
  streamDelta,
  streamRetry,
  streamStart,
} from "./http/schemas.ts";
import { DEFAULT_HEARTBEAT_MS } from "./http/sse.ts";

/** The shell the examples are written for: PowerShell on Windows, bash or zsh elsewhere. */
export type ExampleShell = "powershell" | "sh";

/** What the `docs` command shows. */
export interface DocsInfo {
  readonly version: string;
  /** Base URL of the server, from the user's settings. */
  readonly url: string;
  readonly shell: ExampleShell;
  /** The settings file in use, if any. */
  readonly settingsFile?: string;
}

/** The server's base URL from LOOPBACK_PORT, or the default port when it isn't usable. */
export function docsUrl(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.LOOPBACK_PORT ?? "";
  const port = /^\d+$/.test(value) ? Number(value) : 0;
  return `http://127.0.0.1:${port >= 1 && port <= 65_535 ? port : DEFAULT_PORT}`;
}

interface JsonSchema {
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly items?: JsonSchema;
}

interface Operation {
  readonly summary: string;
  readonly security?: readonly unknown[];
}

const typeName = (schema: JsonSchema): string =>
  schema.type === "array" && schema.items !== undefined
    ? `${typeName(schema.items)}[]`
    : (schema.type ?? "any");

const keys = (schema: z.ZodObject) => `{ ${Object.keys(schema.shape).join(", ")} }`;

/** Rows of cells, each column padded to its widest cell. */
function table(rows: readonly (readonly string[])[], style: Style, first = "cyan"): string[] {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    `  ${row
      .map((cell, column) => {
        const padded = column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0);
        return column === 0 ? style(first, padded) : padded;
      })
      .join("  ")}`.trimEnd(),
  );
}

function routes(style: Style): string[] {
  const paths = buildOpenApiDocument().paths as Record<string, Record<string, Operation>>;
  const rows = Object.entries(paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => [
      method.toUpperCase(),
      path,
      operation.security?.length === 0 ? "no token" : "",
      operation.summary,
    ]),
  );
  return table(rows, style, "green");
}

function requestFields(style: Style): string[] {
  const schema = z.toJSONSchema(promptRequest, { io: "input" }) as {
    properties: Record<string, JsonSchema>;
    required?: string[];
  };
  const rows: string[][] = [];
  for (const [name, field] of Object.entries(promptRequest.shape)) {
    const json = schema.properties[name] ?? {};
    const required = schema.required?.includes(name) ? "(required) " : "";
    rows.push([name, typeName(json), `${required}${field.description ?? ""}`]);
    if (json.enum !== undefined) rows.push(["", "", `one of ${json.enum.join(" | ")}`]);
  }
  return table(rows, style);
}

function responseFields(style: Style): string[] {
  const rows = Object.entries(promptResponse.shape).map(([name, field]) => [
    name,
    field.description ?? "",
  ]);
  return table(rows, style);
}

function streamEvents(style: Style): string[] {
  return [
    ...table(
      [
        ["start", `${keys(streamStart)}: the run began`],
        ["delta", `${keys(streamDelta)}: the next piece of the answer`],
        ["retry", `${keys(streamRetry)}: Claude Code is retrying an API error`],
        ["result", "the RESPONSE body above; always the last event on success"],
        ["error", "the ERRORS body below; always the last event on failure"],
      ],
      style,
    ),
    `  ": ping" comments arrive every ${DEFAULT_HEARTBEAT_MS / 1000} s to keep the connection open.`,
    "  Problems found before the run starts come back as plain JSON errors instead.",
  ];
}

function errors(style: Style): string[] {
  const byStatus = new Map<ErrorStatus, string[]>();
  // cancelled (499) means the client already went away, so no client ever receives it.
  for (const code of ERROR_CODES.filter((code) => code !== "cancelled")) {
    const status = errorStatus(code);
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }
  const rows = [...byStatus.entries()]
    .sort(([a], [b]) => a - b)
    .map(([status, codes]) => [String(status), codes.join(", ")]);
  return [
    ...table(rows, style),
    "  429 responses may carry Retry-After: the seconds to wait before trying again.",
  ];
}

const comment = (style: Style, text: string) => style("dim", `  # ${text}`);

function powershellExamples(url: string, style: Style): string[] {
  return [
    comment(style, "Load your token (don't type or paste it: shell history keeps what you type)"),
    "  $env:LOOPBACK_TOKEN = (claude-loopback token)",
    '  $headers = @{ Authorization = "Bearer $env:LOOPBACK_TOKEN" }',
    "",
    comment(style, "Check Claude Code is found and logged in"),
    `  Invoke-RestMethod ${url}/ready -Headers $headers`,
    "",
    comment(style, "Run a prompt and wait for the answer"),
    '  $body = @{ prompt = "Reply with exactly the word: pong" } | ConvertTo-Json',
    `  $reply = Invoke-RestMethod ${url}/v1/prompt -Method Post -Headers $headers \``,
    "    -ContentType application/json -Body $body",
    "  $reply.text",
    "",
    comment(style, "Stream the answer as it arrives (PowerShell 7.3 or newer)"),
    `  curl.exe -N ${url}/v1/prompt/stream \``,
    '    -H "Authorization: Bearer $env:LOOPBACK_TOKEN" -H "Content-Type: application/json" `',
    `    -d '{"prompt": "Write a haiku about pipes"}'`,
  ];
}

function shExamples(url: string, style: Style): string[] {
  const auth = '-H "Authorization: Bearer $LOOPBACK_TOKEN"';
  return [
    comment(style, "Load your token (don't type or paste it: shell history keeps what you type)"),
    '  export LOOPBACK_TOKEN="$(claude-loopback token)"',
    "",
    comment(style, "Check Claude Code is found and logged in"),
    `  curl ${url}/ready ${auth}`,
    "",
    comment(style, "Run a prompt and wait for the answer"),
    `  curl ${url}/v1/prompt \\`,
    `    ${auth} -H "Content-Type: application/json" \\`,
    `    -d '{"prompt": "Reply with exactly the word: pong"}'`,
    "",
    comment(style, "Stream the answer as it arrives"),
    `  curl -N ${url}/v1/prompt/stream \\`,
    `    ${auth} -H "Content-Type: application/json" \\`,
    `    -d '{"prompt": "Write a haiku about pipes"}'`,
  ];
}

/** A short API reference for the terminal: routes, fields, events, errors and examples. */
export function formatDocs(info: DocsInfo, style: Style): string {
  const heading = (title: string, note = "") => [
    "",
    `${style("bold", title)}${note === "" ? "" : `  ${style("dim", note)}`}`,
  ];
  const row = (label: string, value: string) => `  ${style("bold", label.padEnd(9))}  ${value}`;

  return [
    "",
    `${style(["bold", "cyan"], "claude-loopback")} ${style("dim", info.version)} · API reference`,
    "",
    row(
      "Base URL",
      `${style("cyan", info.url)}  ${style("dim", "(start it with: claude-loopback)")}`,
    ),
    row("Auth", `Authorization: Bearer <token>  ${style("dim", "(claude-loopback token)")}`),
    row("Bodies", "Content-Type: application/json"),
    ...heading("ROUTES"),
    ...routes(style),
    ...heading("REQUEST BODY", "both prompt routes; unknown fields are rejected"),
    ...requestFields(style),
    "  A request can only narrow what your settings allow, never widen it.",
    ...heading("RESPONSE", "POST /v1/prompt"),
    ...responseFields(style),
    ...heading("STREAM EVENTS", "POST /v1/prompt/stream, as text/event-stream"),
    ...streamEvents(style),
    ...heading("ERRORS", '{ "error": { "code", "message", "requestId" } }'),
    ...errors(style),
    ...heading("EXAMPLES", info.shell === "powershell" ? "PowerShell" : "bash or zsh"),
    ...(info.shell === "powershell" ? powershellExamples : shExamples)(info.url, style),
    ...heading("MORE"),
    row(
      "Full spec",
      `${style("cyan", `${info.url}/openapi.json`)}  ${style("dim", "(OpenAPI 3.1)")}`,
    ),
    ...(info.settingsFile === undefined ? [] : [row("Settings", info.settingsFile)]),
    "",
  ].join("\n");
}
