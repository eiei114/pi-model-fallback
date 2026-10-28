# Pi SDK 1.4.0 compatibility

This package is verified with the frozen development/test versions:

- `@earendil-works/pi-agent-core`: `1.4.0`
- `@earendil-works/pi-ai`: `1.4.0`
- `@earendil-works/pi-coding-agent`: `1.4.0`
- `@earendil-works/pi-tui`: `1.4.0`

These exact versions are dev/test pins. Public peer dependency ranges are
unchanged; the package continues to require Pi 1.1 or later.

The 1.2.0 notes in the upstream
[Pi SDK compatibility notes](https://github.com/eiei114/pi-extension-template/blob/main/docs/pi-sdk-compatibility.md)
record the `before_agent_start` message-type union and startup busy-state
changes. Moving the pins from 1.2.0 to 1.4.0 required no production API
migration either: the extension still reads only `getKeybindings()` matching and
the `onTerminalInput` observer, both of which are unchanged through 1.4.0.

The four Pi packages must be bumped together. `app.interrupt` and the other app
keybinding ids reach `Keybindings` through a `declare module` augmentation that
ships in `@earendil-works/pi-coding-agent`, so bumping `pi-tui` alone (or any
single package) leaves `getKeybindings().matches(data, "app.interrupt")`
failing typecheck with `not assignable to parameter of type 'keyof Keybindings'`.

From a repository checkout, run `npm run smoke:pi` to exercise the installed
local Pi CLI and RPC host with this extension. The deterministic offline provider
returns a source 429 and a successful fallback response; the harness also checks
a handled invalid config, a second-process reload and feature response, clean
shutdown, and the native host shell. It uses an isolated agent directory and
makes no paid inference. `npm run ci` runs the smoke as well as typecheck, tests,
and pack dry-run.
