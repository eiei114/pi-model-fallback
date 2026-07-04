# pi-model-fallback

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

## State and paths

The extension stores:

- config: `model-fallback/config.json`
- state: `model-fallback/state.json`

If the package is installed project-locally and the current project references it from `.pi/settings.json`, those files live under the project `.pi/` directory. Otherwise they live under the user agent directory.

## Behavior notes

- Successful responses do nothing.
- Matching failures from `after_provider_response` can trigger fallback immediately.
- Assistant error messages parsed at `turn_end` can also persist fallback state for SDK/provider failures that do not emit the normal response hook.
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
