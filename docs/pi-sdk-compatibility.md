# Pi SDK 1.5.0 compatibility

This package is verified with the frozen development/test versions:

- `@earendil-works/pi-agent-core`: `1.5.0`
- `@earendil-works/pi-ai`: `1.5.0`
- `@earendil-works/pi-coding-agent`: `1.5.0`
- `@earendil-works/pi-tui`: `1.5.0`

These exact versions are dev/test pins. Public peer dependency ranges are
unchanged; the package continues to require Pi 1.1 or later.

The 1.2.0 notes in the upstream
[Pi SDK compatibility notes](https://github.com/eiei114/pi-extension-template/blob/main/docs/pi-sdk-compatibility.md)
record the `before_agent_start` message-type union and startup busy-state
changes. Moving the pins from 1.2.0 through 1.4.0 required no production API
migration: the extension still reads only `getKeybindings()` matching and the
`onTerminalInput` observer, both of which are unchanged through 1.5.0.

The four Pi packages must be bumped together. `app.interrupt` and the other app
keybinding ids reach `Keybindings` through a `declare module` augmentation that
ships in `@earendil-works/pi-coding-agent`, so bumping `pi-tui` alone (or any
single package) leaves `getKeybindings().matches(data, "app.interrupt")`
failing typecheck with `not assignable to parameter of type 'keyof Keybindings'`.

## 1.5.0 changes that touch this extension

- **Tool argument validation moved to `@earendil-works/pi-schema`.** The
  `model_fallback_config` tool schema stays plain JSON Schema
  (`Type.Object`, `Type.Union` of `Type.Literal`, `Type.Optional(Type.String())`),
  so it validates unchanged. Only TypeBox features outside JSON Schema are
  affected: `Type.Refine()` refinements, `Type.BigInt()`, `Type.Undefined()`,
  codecs and `Format.Set()` formats no longer apply to tool arguments. This
  package uses none of them, and argument coercion (numeric strings, `"true"`,
  a single value into a one-item array, `null` in an optional property) is now
  applied to every tool, including this one. `tests/tool-schema.test.mjs`
  asserts the 1.5.0 validator behaviour against the real host: a valid call
  reaches `execute()`, and both an unknown action and a missing `action` come
  back as `- action: expected "read"` and `- action: missing` tool results.
- **`@earendil-works/pi-ai` no longer re-exports TypeBox.** Inside Pi the
  imports still resolve, but the published package keeps `Type`, `Static` and
  `TSchema` at the compat entry only. The extension and the tests import
  `Type` from `typebox` directly, which is the documented import for new code,
  so no change was needed.
- **`keyText()`/`keyHint()` are injected by Pi.** Pi warns that importing them
  from `@earendil-works/pi-coding-agent` can resolve an extension-local copy
  that cannot see Pi's keybindings. This extension renders no key hints, so
  there is nothing to migrate.

## Verifying a wave

From a repository checkout, run `npm run smoke:pi` to exercise the installed
local Pi CLI and RPC host with this extension. The deterministic offline provider
returns a source 429 and a successful fallback response; the harness also checks
a handled invalid config, a second-process reload and feature response, clean
shutdown, and the native host shell. It uses an isolated agent directory and
makes no paid inference. `npm run ci` runs the smoke as well as typecheck, tests,
and pack dry-run.

`tests/tool-schema.test.mjs` runs the same real Pi SDK in-process and calls the
`model_fallback_config` tool: valid arguments must reach `execute()` and return
the extension's status text, while an unknown action and a missing required
field must come back as pi-schema validation errors (`- action: expected
"read"`, `- action: missing`) inside a `toolResult`. The TypeBox phrasing those
assertions exclude is what a 1.4.0 host produced, so the test fails if the
validator handoff regresses.

Re-record the committed report with `node scripts/pi-sdk-smoke.mjs --record`
after changing the pins; an ordinary `npm run smoke:pi` run writes only to the
git-ignored `tmp/` report and fails if the committed report would change.
