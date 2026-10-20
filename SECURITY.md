# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately: on GitHub, open the repository's **Security** tab and
choose **Report a vulnerability**. Don't open a public issue for a security problem.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a
reply as soon as possible; fixes are released as a new npm version.

## Scope

claude-loopback is a personal, localhost-only server: it listens on `127.0.0.1` only and runs
prompts through the owner's own Claude Code login. In scope, for example:

- Reaching the API without the token, or from a web page in a browser (DNS rebinding, CORS).
- A request making Claude Code run with more tools, settings or permissions than configured.
- Leaking the token, prompts or file paths through responses or logs.
- Claude Code processes or temporary folders left behind after a run.
- Another account on the same machine reading the token or interfering with the server.

Out of scope: malware already running as the owner's own account, and risks the owner opts into
by enabling tools (see "Security" in the README).

## Supported versions

Only the latest published version gets fixes.
