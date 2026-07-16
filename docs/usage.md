# Usage

Install:

```bash
pi install npm:pi-model-fallback
```

Default behavior: when a `zai/*` model receives `429`, `500`, `502`, `503`, or `504`, Pi switches to `deepseek/deepseek-v4-flash` for the next prompt.

Commands:

```text
/model-fallback:status
/model-fallback:reset
```

Cooldown defaults when a rule omits `cooldownMs`:

- `429` → 72 hours
- `5xx` → 10 minutes

`Retry-After` and `x-ratelimit-reset*` response headers override `cooldownMs` and those defaults.

The failed request is not automatically replayed.
