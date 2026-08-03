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
- `cooldownMs`: optional persistent fallback window
- `fallback`: target model Pi should switch to

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

## Behavior notes

- Successful responses do nothing.
- Matching failures from `after_provider_response` can trigger fallback immediately.
- Assistant error messages parsed at `turn_end` can also persist fallback state for SDK/provider failures that do not emit the normal response hook. Status extraction looks for HTTP-style tokens (for example `status 429`, `HTTP 503`, or `rate limit`) rather than any bare 3-digit number in the message.
- The failed request is not automatically replayed.

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