# Usage

Requires Pi 1.1 or later. Install:

```bash
pi install npm:pi-model-fallback
```

Default behavior: when a `zai/*` model fails with `429`, `500`, `502`, `503`, or `504`, Pi finishes its own retries, switches to `deepseek/deepseek-v4-flash`, and continues the existing conversation without replaying the user prompt. Completed tool results and images remain in context. Set `"autoRetry": false` in `model-fallback/config.json` to switch models without continuing.

The selected session model changes; subsequent requests use that model directly. Interrupting a pending fallback prevents continuation, although a model change already in progress may remain. A chain never revisits a model within the same user run.

Commands:

```text
/model-fallback:status
/model-fallback:clear [provider/model]
/model-fallback:reset
```

Rule order is first-match: the first rule whose provider/model and status match wins. Place specific `matchModels` rules before broad `matchProviders` rules when the model-specific fallback should take priority. `model_fallback_config validate`, `save`, `read`, and `status` expose warning-only details for completely shadowed later rules or model entries, and `/model-fallback:status` includes a concise current-config warning summary; these warnings do not make the config invalid.

Rules can also match on failure reasons with `reasons`, for example `"reasons": ["context_length_exceeded"]` on a `400` rule so only context-overflow failures switch models while other `400`s stay errors. Reasons are parsed from quoted provider error codes (for example `"provider_error_code":"context_length_exceeded"`) or prose such as `exceeds this model's context length`. A rule never falls back to the failing model itself.

Cooldown defaults when a rule omits `cooldownMs`:

- `429`/`529` with exhausted-quota wording (`usage limit`, `insufficient_quota`, `out of budget`, `额度`, `余额`) → 72 hours
- `429`/`529` with overload/throttling wording, including unrecognized text (`该模型当前访问量过大`, `temporarily overloaded`, `Too Many Requests`) → `transientCooldownMs`, 10 minutes
- `5xx` → 10 minutes

A transient cooldown heals itself. Once a transient entry is older than `recoveryProbeMs` (15 minutes by default), the next session retries the source model instead of preselecting the fallback, and a successful turn clears the entry; an interrupted turn does not count, and a repeated failure persists a fresh one. Quota entries keep their full cooldown and are never retried early, and neither is a transient entry whose window came from an explicit rule `cooldownMs` or a `Retry-After`/`x-ratelimit-reset*` header. `/model-fallback:clear <provider/model>` drops a single entry without changing the active model, which is the escape hatch for entries written by earlier versions (they carry no transient flag and keep their original cooldown).

`Retry-After` and `x-ratelimit-reset*` response headers override `cooldownMs`, `transientCooldownMs`, and those defaults.

If `autoRetry` is disabled, the existing run is not automatically continued.

Shared cooldown state uses a cross-process lock and atomic file replacement. Concurrent failures merge against the latest file, not a session's cached snapshot. Reset takes the same lock and can repair a malformed state file; it clears earlier commits, not failures committed afterward. Expired entries are ignored when selecting a model and cleaned up during the next state mutation. Lock/write failures are reported instead of performing an unlocked overwrite.
