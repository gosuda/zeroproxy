# Dogfood baseline 2026-06-08

- target: https://gosuda.org
- proxy:  http://proxy.localhost:18080/zp/
- final url: 
- final title: (empty)
- screenshot: `.ai\dogfood\2026-06-08\baseline.png`
- console errors: 0

## Console error sample

```json
{
  "error": "CONSOLE_LOGS_ERROR",
  "message": "JS_EXECUTION_ERROR: Execution timeout (3000ms)",
  "status": "failed"
}
```

## Acceptance check (manual)

- [ ] page renders without `MALFORMED_HTML` / `REWRITE_FAILED` / `SW_NOT_READY`
- [ ] `/zp/p/` path preserved in final URL
- [ ] only known-deferred console errors present
