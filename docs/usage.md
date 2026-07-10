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

The failed request is not automatically replayed.
