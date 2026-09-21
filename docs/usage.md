# Usage

Install:

```bash
pi install npm:pi-model-fallback
```

Default behavior: when a `zai/*` model receives `429`, `500`, `502`, `503`, or `504`, Pi switches to `deepseek/deepseek-v4-flash` for the next prompt. The failed prompt is automatically queued once on the fallback model; set `"autoRetry": false` in `model-fallback/config.json` to switch models without retrying it.

Commands:

```text
/model-fallback:status
/model-fallback:reset
```

Rule order is first-match: the first rule whose provider/model and status match wins. Place specific `matchModels` rules before broad `matchProviders` rules when the model-specific fallback should take priority. `model_fallback_config validate`, `save`, `read`, and `status` expose warning-only details for completely shadowed later rules or model entries, and `/model-fallback:status` includes a concise current-config warning summary; these warnings do not make the config invalid.

Rules can also match on failure reasons with `reasons`, for example `"reasons": ["context_length_exceeded"]` on a `400` rule so only context-overflow failures switch models while other `400`s stay errors. Reasons are parsed from quoted provider error codes (for example `"provider_error_code":"context_length_exceeded"`) or prose such as `exceeds this model's context length`. A rule never falls back to the failing model itself.

Cooldown defaults when a rule omits `cooldownMs`:

- `429` → 72 hours
- `5xx` → 10 minutes

`Retry-After` and `x-ratelimit-reset*` response headers override `cooldownMs` and those defaults.

If `autoRetry` is disabled, the failed request is not automatically replayed.
