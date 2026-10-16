# Pi SDK 1.2.0 compatibility

This package is verified with the frozen development/test versions:

- `@earendil-works/pi-agent-core`: `1.2.0`
- `@earendil-works/pi-ai`: `1.2.0`
- `@earendil-works/pi-coding-agent`: `1.2.0`
- `@earendil-works/pi-tui`: `1.2.0`

These exact versions are dev/test pins. Public peer dependency ranges are
unchanged; the package continues to require Pi 1.1 or later.

The upstream [Pi SDK compatibility notes](https://github.com/eiei114/pi-extension-template/blob/main/docs/pi-sdk-compatibility.md)
record the 1.2.0 `before_agent_start` message-type union and startup busy-state
changes. This extension does not read user-only event fields, so no production
API migration was needed. Tests now construct the current `messageType: "user"`
event and account for sessions being busy while startup handlers run.

From a repository checkout, run `npm run smoke:pi` to exercise the installed
local Pi CLI and RPC host with this extension. The deterministic offline provider
returns a source 429 and a successful fallback response; the harness also checks
a handled invalid config, a second-process reload and feature response, clean
shutdown, and the native host shell. It uses an isolated agent directory and
makes no paid inference. `npm run ci` runs the smoke as well as typecheck, tests,
and pack dry-run.
