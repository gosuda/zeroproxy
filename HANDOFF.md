# ZeroProxy — handoff (2026-10-08)

Written for: the next session (agent or engineer) picking up ZeroProxy cold. Read [CLAUDE.md](CLAUDE.md) and
`head -40 .ai/trap-notebook/INDEX.md` first; this file only adds what is not already there.

## State

- Branch `main`. `origin/main` = `8565ccf`. Local commits **not pushed**: `3ae6135` (Stack Overflow fix) and the commit that
  carries this file. The user has not yet said to push them — ask.
- Commits of this arc: `8c178a7` HLS / loop cap / `innerHTML` / TLS refresh (ERRATA 58–61) · `8565ccf` five divergences found
  chasing the challenge (62–65) · `3ae6135` **Stack Overflow's Cloudflare challenge fixed** — the ClientHello lacked Chrome's
  `trust_anchors` extension — plus `Sec-Fetch-*` for frames and sub-requests (66–67) · the next commit: element-load
  `Sec-Fetch-*` and `sendBeacon` as `no-cors`, `scripts/check-chrome-hello.mjs`, this file.
- Verification with the element-load commit: cargo 304 pass / 3 ignored, `go test ./...` ok, `npm run test:js` 163,
  `npm run test:wasm:ci` 13, `npm run test:e2e` 221, `node test/js/static-policy.test.js` 61; the 13-site live sweep
  (`taskweaver` instance `zp`) after it: all thirteen answer, Stack Overflow loads. Naver shows ad-pixel 502s and an intermittent 504 on
  `ssl.pstatic.net` images (a CSS `sync-fetch`); an A/B with the element metadata reverted showed the same 504s, so it is
  transient, not this change.
- Detail lives in [ERRATA.md](ERRATA.md) items 62–67 and its Residuals table, the trap-notebook entries `동적-코드-전역-this`
  and `chrome-hello-trust-anchors` (`.ai/trap-notebook/rewriter.md`), and the verification table in
  [PHASE2_STATUS.md](PHASE2_STATUS.md). No gate in PHASE2_STATUS is open.

## Next steps (suggested, in order)

1. **Ask before pushing** (see State).
2. **Persona drift.** The persona is Chrome 154. Run `npm run check:chrome-hello` after a Chrome update: it opens the installed
   Chrome against a local listener and compares its ClientHello extensions and `trust_anchors` body with the SW's
   `CAPTURED_FINGERPRINT_B64` and `third_party-rustls-fork/src/ja3.rs` (exit 1 = drift, 2 = no Chrome). Bump the persona
   (`web/zp-core.js`, `web/worker-prelude.js`, the spec, the constant) together;
   `crates/zp-kernel-bundle/tests/client_hello.rs` pins the result.
3. **Glassdoor** still does not get through (ERRATA Residuals). Natively an unautomated Chrome passes in ~4 s; through the
   proxy the same `chl_page` + `light` Turnstile challenge starts and never completes. **Use a clean IP / wait between
   tries**: after a few attempts Cloudflare answers "Humans only" and nothing is comparable (it happened to this IP). The
   tools: `taskweaver` on `zp` for the proxied side (`nav-log`, `failed-requests`, `exec-js --target sw`), and a hand-launched
   Chrome for the native side (recipe below). A page that is busy computing the challenge does not answer `evaluate`; stream
   from the page with `console.debug` instead of polling.
4. Worker scripts: a worker's script is fetched by its bootstrap through the runtime API, so the server sees `cors`/`empty`
   instead of `same-origin`/`worker` (ERRATA 67). `sec-fetch-storage-access` is not sent on cross-site sub-requests.
5. Inline-script `Error.stack` ends in `eval (url:L:C)` + `eval (<anonymous>)` (ERRATA Residuals); the prelude is minified, so
   frames cannot be told apart by function name.
6. Reddit still answers "Prove your humanity" on a cold profile (judged parity with native; not re-verified since).

## How to run things

```bash
node scripts/build.mjs                        # full; stop zeroproxy-server.exe first (exe lock)
node scripts/build.mjs --web-only --no-clean  # web only — also how to undo a hand-patch of dist/
./dist/zeroproxy-server.exe -web "$(realpath dist/web)" -addr 127.0.0.1:18080 -socks internal
taskweaver start --id zp --width 1200 --height 800     # only if `taskweaver list` shows no zp
```

A server may still be running on 18080 (`taskkill //F //IM zeroproxy-server.exe`). `taskweaver upgrade` stops every daemon —
restart `zp` afterwards.

### Comparing with a real Chrome (the method that found the Cloudflare cause)

1. **A real, unautomated browser, not an automated one.** Start Chrome yourself with a throw-away profile and attach:
   `chrome.exe --user-data-dir=<tmp> --remote-debugging-port=<port> --no-first-run about:blank`, then
   `puppeteer.connect({ browserURL })`. A puppeteer-`launch`ed Chrome is judged differently by bot defences. Delete the
   profile and kill *that* process afterwards (see Traps).
2. **Compare bytes on the wire.** `scripts/check-chrome-hello.mjs` is the pattern: a TCP listener records the first flight; the
   browser opens `https://localhost:PORT/` natively and through the launcher.
3. **Per-hop requests.** Proxied side: `taskweaver exec-js --target sw --script "return outgoingHeaderLog.map(...)"` (each entry
   has the response `status`; `refusalLog`, `tabs`, `shareRoutes` are readable too). Native side: puppeteer
   `page.on('request'|'response')`, or CDP `Network.requestWillBeSentExtraInfo` for the headers as sent.
4. **Challenge type, not just pass/fail:** `orchestrate/precursor_interstitial` (light, in-page) vs `orchestrate/chl_page` +
   a Turnstile frame (heavy).

The remaining scratch tools (`fresh-chrome*.js`, `api-trace3.js`, `frame-timeline.js`, `coep-timeline.js`, `so-try.sh`,
`matrix3.sh`, `mut.js`, …) live in **`.lean-ctx/`, which is gitignored** — local to this machine. Promote the ones you
need into `scripts/`.

## TaskWeaver (browser CLI, now 0.18.0)

The user fixed what was asked for last session. Verified in use: `exec-js --target sw`, `nav-log` (per-hop timeline incl.
frames and blocked reasons — it is how the COEP block was found), `failed-requests`, `--field`/`--jq`/`--raw`. Present per
`--help`, not exercised: `cookies list|clear`, `reset`, `record on|off`, `--private-profile`, and **`--engine chrome`** (a real
Chrome, throw-away profile, no automation flags).

**Policy decision:** CLAUDE.md allows only `--id zp`. The user was asked whether a short-lived `--engine chrome` instance
(`zpc`) may be used for Chrome-side comparisons and said **no — keep `zp` only**. So the Chrome side is done with
hand-launched Chrome (above). If that changes, amend the CLAUDE.md policy line first.

## Traps that cost time

- **"Matches X" must say which X.** The wire was matched to WebView2 (Edge) while the persona says Chrome; they differ by one
  extension (ERRATA 66).
- **An automated browser failing is not evidence about "the environment".**
- **`navigate` completes on a challenge page** and an invisible challenge solves itself within the wait — use `nav-log`.
- **Park `zp` on `about:blank` before `npm run test:e2e`.** With `zp` left on a looping challenge page the E1 block lost a
  worker probe and timed out (13 failures); the same tree passed 221/221 right after. The earlier "e2e printed no summary" was
  probably the same kind of outside load.
- **Repeated tests escalate the IP.** After a handful of Glassdoor attempts Cloudflare served a block page instead of the
  challenge. Space the runs; do not trust a comparison taken after many.
- **`dist/web/sw.js` inlines `zp-core.js`.** Patching `dist/web/zp-core.js` does nothing to the SW; patch the copy at the top of
  `sw.js`. Imports are also HTTP-cached by their `?v=` URL.
- **`crates/zp-kernel-bundle` is `cfg(target_arch = "wasm32")` only.** Native tests cannot call kernel functions; the hello test
  mirrors `captured_spec_from_json` — keep them in step.
- **Rewriter kinds:** a direct `eval` inside a function is `ScriptKind::ClassicLocal` (`"classic-local"`); making top-level
  `this` read the facade without it broke `evalThis`.
- **The Bash tool halves backslashes inside heredocs / `node -e` / `sed`.** Write any file that contains regexes or escapes with
  the Write/Edit tools.
- **Never `taskkill //IM chrome.exe`.** It closes the user's own Chrome (happened once). Filter by command line
  (`Get-CimInstance Win32_Process`, `zp-fresh-` in the user-data-dir).
- Commits: Korean message through `git commit -F file` (or PowerShell), **no** `Co-Authored-By`/"Generated with" trailers.
