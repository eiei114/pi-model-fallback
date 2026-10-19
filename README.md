# pi-model-fallback

[![Join dotfield.xyz on Discord](https://img.shields.io/badge/Join%20dotfield.xyz%20on%20Discord-5865F2?logo=discord&logoColor=white)](https://discord.gg/4945dXZVW5)

[![CI](https://github.com/eiei114/pi-model-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-model-fallback/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-model-fallback/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-model-fallback/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-model-fallback.svg)](https://www.npmjs.com/package/pi-model-fallback)
[![npm downloads](https://img.shields.io/npm/dm/pi-model-fallback.svg)](https://www.npmjs.com/package/pi-model-fallback)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple.svg)](https://pi.dev/packages)
<a href="https://buymeacoffee.com/ekawano114m"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" width="217" height="60"></a>

> Pi extension that switches to a fallback model after provider failures such as 429 rate limits.

## What this does

`pi-model-fallback` watches provider failures and automatically moves Pi to a safer fallback model when a matching rule fires.

Current default:

- source provider: `zai`
- matching statuses: `429`, `500`, `502`, `503`, `504`
- fallback model: `deepseek/deepseek-v4-flash`

When a failure matches, the extension also stores persistent fallback state so future sessions can preselect the fallback model until the cooldown expires.

## Install

Requires Pi 1.1 or later for the continuation boundary API.

Install from npm:

```bash
pi install npm:pi-model-fallback
```

Install into the current project only:

```bash
pi install npm:pi-model-fallback -l
```

Or install from GitHub:

```bash
pi install git:github.com/eiei114/pi-model-fallback
```

Try it without permanently installing:

```bash
pi -e npm:pi-model-fallback
```

## Commands

```text
/model-fallback:status
/model-fallback:reset
```

- `status`: shows whether fallback is enabled, active persistent entries, and current paths
- `reset`: clears persistent fallback state and switches back to the remembered original model when possible

## Configuration

The extension exposes the `model_fallback_config` tool for reading, validating, and saving config JSON.

Default config shape:

```json
{
  "version": 1,
  "enabled": true,
  "autoRetry": true,
  "rules": [
    {
      "name": "zai-to-deepseek-flash",
      "matchProviders": ["zai"],
      "statuses": [429, 500, 502, 503, 504],
      "fallback": {
        "provider": "deepseek",
        "model": "deepseek-v4-flash"
      }
    }
  ]
}
```

Rule fields:

- `matchProviders`: match all models from a provider
- `matchModels`: match specific `provider` + `model` pairs
- `statuses`: optional; defaults to `429, 500, 502, 503, 504`
- `reasons`: optional list of failure reason codes (for example `context_length_exceeded`); when set, the rule only fires if the parsed failure reason is listed. Reasons come from quoted machine codes in the error message (for example `"provider_error_code":"context_length_exceeded"`) or prose such as `exceeds this model's context length`. Useful for status codes like `400` that should only trigger a fallback for specific causes, such as context-length overflow.
- `cooldownMs`: optional persistent fallback window
- `fallback`: target model Pi should switch to

Top-level fields:

- `enabled`: toggle the extension without deleting rules
- `autoRetry`: after Pi exhausts its own retries, continue the existing conversation on the fallback model without re-queueing the user prompt (defaults to `true`; set to `false` to only switch models). Completed tool results and image inputs remain in context; only the failed assistant entry is excluded.

Rules use first-match order: the first rule whose provider/model and status match wins. Put specific `matchModels` rules before broad `matchProviders` rules when they should take priority. `model_fallback_config validate`, `save`, `read`, and `status` report warning-only diagnostics when a later rule or model entry is completely shadowed by an earlier rule; `/model-fallback:status` also includes a concise warning summary for the current config. Warning-bearing config remains valid and can still be saved.

### Cooldowns

When a rule does not set `cooldownMs`, the extension uses these defaults:

- `429` → 72 hours
- `5xx` → 10 minutes

When the provider response includes `Retry-After` or `x-ratelimit-reset*` headers, those values override `cooldownMs` and the defaults for the persisted fallback window.

## State and paths

The extension stores:

- config: `model-fallback/config.json`
- state: `model-fallback/state.json`

If the package is installed project-locally and the current project references it from `.pi/settings.json`, those files live under the project `.pi/` directory. Otherwise they live under the user agent directory.

Cooldown updates re-read and merge the current state under a shared `proper-lockfile` lock, including across Pi processes. Reset uses the same lock. State is published by atomic replacement, so readers never see a partially written document; expired entries are ignored on read and removed during the next mutation. Lock acquisition is bounded (about two seconds of retries); a lock or write error is reported rather than overwriting state without the lock. A reset clears entries committed before it; a new failure committed afterward can create a new cooldown.

## Behavior notes

- Successful responses do nothing.
- Failed HTTP responses are recorded by `after_provider_response`; model switching waits until Pi's retry/recovery paths finish at `agent_before_settle`.
- Assistant error messages parsed at `turn_end` identify SDK/provider failures that do not emit the normal response hook. When friendly error text omits a status, the extension uses the observed HTTP status and headers from the same model request. Status extraction looks for HTTP-style tokens (for example `status 429`, `HTTP 503`, or `rate limit`) rather than any bare 3-digit number in the message. A status in parentheses is only recognized when an error wrapper keyword precedes it, as in `omni API error (503): ...`; a parenthesized number with no such wrapper, such as `(503) items processed`, stays unmatched.
- Anthropic SDK errors with a bare status followed by JSON (for example `429 {"type":"error",...}`) are recognized. Status-free Anthropic streaming errors map `rate_limit_error` to `429`, `overloaded_error` to `529`, and `api_error` to `500`; an interrupted stream maps to `502`. Add `529` to a rule's `statuses` if it should cover Anthropic overloads. Supported connection failures without an HTTP response map to `503`; cancellation, refusals, and ordinary numeric prose stay unmatched, and explicit HTTP statuses take precedence.
- With the default `autoRetry: true`, the existing run continues on the fallback model without a second user request. Set `autoRetry: false` to switch models without continuing.
- Interrupting a pending fallback prevents continuation. An in-flight model change is not atomic with cancellation: the selected model may change, but the extension will not request another inference after the interrupt.
- Switching providers sends the existing model context to the target provider. Preserving completed tool results prevents extension-level replay, not a model independently choosing to repeat an action.

Rules never fall back to the failing model itself; a rule whose fallback target equals the failing model is skipped so the next matching rule (or no rule) applies.

Fallback chains cascade: when the active fallback model itself fails, another matching rule may move the session further (for example `free model → kimi-k2.6 → glm-5.3-flash`). A cascade never revisits a model already used in the current run (the original or an earlier fallback), so circular rule configurations cannot ping-pong; when no unvisited target remains, the failure surfaces normally.

## Development

```bash
npm install
npm run ci
```

Run locally in Pi:

```bash
pi -e .
```

## Links

- npm: https://www.npmjs.com/package/pi-model-fallback
- GitHub: https://github.com/eiei114/pi-model-fallback
- Issues: https://github.com/eiei114/pi-model-fallback/issues
- Usage notes: [`docs/usage.md`](docs/usage.md)

## License

MIT