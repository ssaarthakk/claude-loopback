import { describe, expect, it } from "vitest";
import { type DocsInfo, docsUrl, formatDocs } from "../../src/docs.ts";
import { ERROR_CODES, errorStatus } from "../../src/errors.ts";
import { buildOpenApiDocument } from "../../src/http/openapi.ts";
import { promptRequest, promptResponse } from "../../src/http/schemas.ts";

const info: DocsInfo = { version: "0.1.0", url: "http://127.0.0.1:7337", shell: "powershell" };

const plain = (_format: string | string[], text: string) => text;
const tagged = (format: string | string[], text: string) =>
  `<${[format].flat().join("+")}>${text}</>`;

const text = formatDocs(info, plain);
const lines = text.split("\n");
const lineFor = (pattern: RegExp, within = lines) => within.find((line) => pattern.test(line));
/** The lines under a heading, up to the blank line that ends its section. */
function section(title: string): string[] {
  const start = lines.findIndex((line) => line.startsWith(title));
  return lines.slice(start + 1, lines.indexOf("", start));
}

describe("formatDocs", () => {
  it("names the version, the base URL and how to authenticate", () => {
    expect(text).toContain("claude-loopback 0.1.0");
    expect(text).toContain("http://127.0.0.1:7337");
    expect(text).toContain("Authorization: Bearer");
    expect(text).toContain("claude-loopback token");
    expect(text).toContain("Content-Type: application/json");
  });

  it("lists every route in the OpenAPI document with its method, token need and summary", () => {
    const paths = buildOpenApiDocument().paths as Record<
      string,
      Record<string, { summary: string; security?: unknown[] }>
    >;
    for (const [route, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const line = lineFor(new RegExp(`\\b${method.toUpperCase()}\\s+${route}\\s`));
        expect(line, `${method} ${route}`).toBeDefined();
        expect(line).toContain(operation.summary);
        const open = Array.isArray(operation.security) && operation.security.length === 0;
        expect(line?.includes("no token"), `${route} token`).toBe(open);
      }
    }
  });

  it("documents every request field with its schema description, marking prompt required", () => {
    const request = section("REQUEST BODY");
    for (const [field, schema] of Object.entries(promptRequest.shape)) {
      expect(schema.description, `${field} has a description`).toBeTruthy();
      const line = lineFor(new RegExp(`^\\s+${field}\\s`), request);
      expect(line, field).toBeDefined();
      expect(line).toContain(schema.description);
    }
    expect(lineFor(/^\s+prompt\s/, request)).toContain("required");
    expect(lineFor(/^\s+model\s/, request)).not.toContain("required");
    expect(text).toContain("low | medium | high | xhigh | max");
  });

  it("documents every response field with its schema description", () => {
    const response = section("RESPONSE");
    for (const [field, schema] of Object.entries(promptResponse.shape)) {
      expect(schema.description, `${field} has a description`).toBeTruthy();
      const line = lineFor(new RegExp(`^\\s+${field}\\s`), response);
      expect(line, field).toContain(schema.description);
    }
  });

  it("names every stream event and the keep-alive ping", () => {
    const events = section("STREAM EVENTS");
    for (const event of ["start", "delta", "retry", "result", "error"]) {
      expect(lineFor(new RegExp(`^\\s+${event}\\s`), events), event).toBeDefined();
    }
    expect(text).toContain(": ping");
  });

  it("lists every error code a client can get on its status line, and leaves out cancelled", () => {
    for (const code of ERROR_CODES.filter((c) => c !== "cancelled")) {
      expect(
        lineFor(new RegExp(`^\\s+${errorStatus(code)}\\s.*\\b${code}\\b`)),
        code,
      ).toBeDefined();
    }
    expect(text).not.toContain("cancelled");
    expect(text).toContain("Retry-After");
  });

  it("builds copy-paste PowerShell examples on the given URL without ever holding a token", () => {
    const custom = formatDocs({ ...info, url: "http://127.0.0.1:8123" }, plain);
    expect(custom).toContain("$env:LOOPBACK_TOKEN = (claude-loopback token)");
    expect(custom).toContain("http://127.0.0.1:8123/v1/prompt");
    expect(custom).toContain("http://127.0.0.1:8123/v1/prompt/stream");
    expect(custom).toContain("http://127.0.0.1:8123/openapi.json");
    expect(custom).not.toContain("7337");
  });

  it("builds copy-paste shell examples for macOS and Linux without ever holding a token", () => {
    const posix = formatDocs({ ...info, url: "http://127.0.0.1:8123", shell: "sh" }, plain);
    expect(posix).toContain('export LOOPBACK_TOKEN="$(claude-loopback token)"');
    expect(posix).not.toContain("$env:");
    expect(posix).not.toContain("Invoke-RestMethod");
    expect(posix).toContain("http://127.0.0.1:8123/v1/prompt");
    expect(posix).toContain("http://127.0.0.1:8123/v1/prompt/stream");
    expect(posix).not.toContain("7337");
  });

  it("shows the settings file only when given", () => {
    expect(text).not.toContain("Settings");
    const file = "C:\\Users\\me\\AppData\\Roaming\\claude-loopback\\config.env";
    expect(formatDocs({ ...info, settingsFile: file }, plain)).toMatch(
      /Settings\s+C:\\Users\\me\\AppData\\Roaming\\claude-loopback\\config\.env/,
    );
  });

  it("fits a 100-column terminal", () => {
    for (const shell of ["powershell", "sh"] as const) {
      const wide = formatDocs({ ...info, shell }, plain)
        .split("\n")
        .filter((line) => line.length > 100);
      expect(wide, shell).toEqual([]);
    }
  });

  it("styles headings through the given style and adds no escape codes itself", () => {
    expect(formatDocs(info, tagged)).toMatch(/<bold[^>]*>ROUTES<\/>/);
    expect(text).not.toContain("\u001b[");
  });
});

describe("docsUrl", () => {
  it("uses the default port when none is set", () => {
    expect(docsUrl({})).toBe("http://127.0.0.1:7337");
  });

  it("uses LOOPBACK_PORT when it is a usable port", () => {
    expect(docsUrl({ LOOPBACK_PORT: "8123" })).toBe("http://127.0.0.1:8123");
  });

  it.each([["0"], ["65536"], ["abc"], ["80.5"], [""], [" 8123"]])(
    "falls back to the default for %j",
    (port) => {
      expect(docsUrl({ LOOPBACK_PORT: port })).toBe("http://127.0.0.1:7337");
    },
  );
});
