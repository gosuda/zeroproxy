# Dogfood baseline 2026-06-08-wikipedia

- target: https://en.wikipedia.org/wiki/Main_Page
- proxy:  http://proxy.localhost:18080/zp/
- final url: http://proxy.localhost:18080/zp/p/5uT5i-2QhwtfTjrEp2dThkhj6IGNppMSc1vdecOr8FQURhZzfk_m-Aj0qsm73KdkV4zEFei-ZFWJZiiFs-DewiK8rfcYnfUnwuO35VcgPFOOiRbhtoPlSlKZFLBwGRmK#k=Bh5oDlWGqP69aqoyzEpymPEVQOk_tKdwNz2pBfs6mT3mpV9yRSzmvjCI8UWSnFhPJ-rWqA8lvrmAJGIblHJBng&server=ws%3A%2F%2Fproxy.localhost%3A18080%2Fzp%2Fws-pipe
- final title: Wikipedia, the free encyclopedia
- screenshot: `.ai\dogfood\2026-06-08-wikipedia\baseline.png`
- console errors: 0

## Console error sample

```json
{
  "cleared": false,
  "count": 0,
  "logs": [],
  "status": "completed"
}
```

## Acceptance check (manual)

- [ ] page renders without `MALFORMED_HTML` / `REWRITE_FAILED` / `SW_NOT_READY`
- [ ] `/zp/p/` path preserved in final URL
- [ ] only known-deferred console errors present
