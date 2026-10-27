# Build & Deploy Regressions

Historical category summaries, not current approved specifications. Recorded measurements and passing results reflect the state at the time of entry without new runtime execution. Past proposed tests and implementation gaps are unverified history, not active TODOs.

<a id="2026-09-26--build-mjs-top-level-await-tdz"></a>
## 2026-09-26: TDZ in `build.mjs` top-level `await`

- Cause: `const membraneDir` (referenced by `readMembraneSource()`) was declared in the helper section at the bottom of the file, so `await buildWeb()` (around line 48) ran before `const` initialization and threw `Cannot access before initialization`.
- Rule: Placing `const` or `let` below a top-level `await` in `build.mjs` triggers a TDZ error. Declare build path constants at the top of the file next to `webSrc`.
- Detection: `node scripts/build.mjs --web-only` immediately fails with a `ReferenceError`.

<a id="2026-05-30-wasm-opt-oz-feature-flags-without-validation-failure"></a>
## 2026-05-30: Missing `wasm-opt` feature flags

- Cause: Binaryen rejected default WASM features emitted by `rustc` 1.82+, causing `-Oz` validation to fail and skipping optimization.
- Fix: Explicitly pass `--enable-bulk-memory`, `--enable-bulk-memory-opt`, `--enable-nontrapping-float-to-int`, `--enable-sign-ext`, `--enable-mutable-globals`, `--enable-multivalue`, and `--enable-reference-types` in `buildRustBundle` in [scripts/build.mjs](../../scripts/build.mjs). Revisit these flags when `rustc` defaults change.
- Status at the time: Both WASM bundles passed; size and wrapper hot paths improved, while internal Rust LTO paths showed minimal change. Installing `npm i -D binaryen` is recommended; `tryRunOptional` keeps the build working when binaryen is absent.

<a id="2026-05-29-upstream-connection-pool-missing"></a>
## 2026-05-29: Missing upstream connection pool

- Cause: Manual HTTP read/write in `bridgeRelayWS` in [cmd/zeroproxy-server/relay.go](../../cmd/zeroproxy-server/relay.go) opened a new TCP/TLS/SOCKS5 connection for every WebSocket request.
- Fix: Cache `http.Transport` instances per direct/Tor dialer via `poolForDial(dial)` and use `RoundTrip`. Configuration sets `MaxIdleConnsPerHost=16`, `MaxIdleConns=200`, `IdleConnTimeout=90s`, `ForceAttemptHTTP2=true`, and `DisableCompression=true` (the Service Worker handles encoding).
- Status at the time: Pooling applied only on the server side; client-to-server transport still used one WebSocket per HTTP request. A dial-counter reuse test was proposed at the time but unverified; client multiplexing was tracked separately.

<a id="2026-05-29-server-web-arg-trap"></a>
## 2026-05-29: Misconfigured server `-web` flag

- Cause: Passing `-web web` points to the source tree instead of the `wasm-bindgen` output under `dist/web/__zp/`. Failed `os.Open` calls result in 503 responses and a missing Service Worker controller.
- Rule: Pass `-web dist/web` or an absolute path; use `-web "$(realpath dist/web)"` to avoid Windows or non-ASCII path resolution issues.
- Status at the time: Asserting the presence of `__zp/zp_bundle_sw.js` at startup was proposed but unverified.

<a id="2026-05-29-windows-zombie-zeroproxy-serverexe"></a>
## 2026-05-29: Zombie server processes on Windows

- Cause: Bash `pkill` left detached `nohup` child processes running, causing port bind failures on the next server start.
- Workaround: Check running processes with `tasklist | grep zeroproxy-server`, then run `taskkill //F //IM zeroproxy-server.exe`; terminating by explicit `//PID <pid>` is safest.
- Status: Recorded as an environment trap with no automated regression guard.

<a id="2026-05-29-two-zeroproxy-serverexe-same-port-listen"></a>
## 2026-05-29: Dual listeners on the same port

- Cause: On Windows, an older server bound to `127.0.0.1:18080` and a new server bound to `0.0.0.0:18080` listened concurrently and served mixed responses.
- Workaround: Run `taskkill //F //IM zeroproxy-server.exe` before restarting and bind to the explicit IP `127.0.0.1:18080`.
- Evidence: `netstat` showed two `LISTENING` entries at the time, with inconsistent `curl` responses.

<a id="2026-08-20-closed-taskweaver-start-call-0161"></a>
## 2026-08-20: `taskweaver start` pipe hang fix

- Cause: Windows `CreateProcessW(bInheritHandles=TRUE)` duplicated inheritable parent handles into the daemon process, preventing stdout pipe EOF (`rust-lang/rust#38227`).
- Fix: Version 0.16.1 (`c99f09e`) clears `HANDLE_FLAG_INHERIT` on the three CLI standard handles immediately before spawning. CLI exit, stderr, and WebView2 child processes were ruled out as causes; graceful stop worked normally.
- Status at the time: `start | cat` and `OUT=$(start ...)` exited cleanly, the full matrix and `static-policy` passed, and no tape data was lost. Background redirection with `list` workarounds was retired, though remnants stayed in `.ai/dogfood/wtm/*.sh`. Handoff notes separated observations from hypotheses.

<a id="2026-08-21-keep-in-sync-is-a-request-not-enforcement"></a>
## 2026-08-21: Error code list drift across languages

- Cause: Despite the "keep in sync" comment in `crates/zp-shared/src/errors.rs`, error code lists in JS, Rust, Go, and separate test arrays diverged. Rust missed `SUBMISSION_EXPIRED`, and `sanitizeCode` downgraded `RTC_GATEWAY_UNAVAILABLE` (`main.go:233`) to `POLICY_BLOCKED`, causing different error pages depending on Service Worker control.
- Fix: Compare all three languages against `testdata/error_codes.json` as the single source of truth, including ordering checks in Rust. Enforce synchronization with a shared fixture rather than comments.
- Discovery: Adding the guard revealed that `TARGET_HTTP_FAILED` was also missing from every list, causing `safeError` to report network and TLS failures as policy blocks; the comment in `sw.js` did not prevent drift.

## <a id="execjs-context"></a>Missing `taskweaver wait` arguments (2026-08-26)

- Cause: Calling `wait` without the required `--id` flag exited immediately with an error that was hidden by discarding stderr. Observed CNN frame differences came from runner invocations that never waited, so they were neither evidence of ad regressions nor proof of `exec-js` context rules, and did not indicate that CNN itself was fixed.
- Rule: Pass `-i zp`, check elapsed time and exit codes, and preserve stderr. Submitting immediately after Service Worker removal also failed without a controller; run `navigate`, `clear-site-data`, `navigate`, and wait in sequence.
- Follow-up correction: Version 0.17 `wait-navigation` detects same-URL re-navigation via sentinel destruction. Start it **before clicking** so the sentinel is planted; starting it after clicking fails with `SENTINEL_PLANT_FAILED`. The `--to` flag in 0.17.0 failed even on matching URLs and was marked do-not-use.
- Status at the time: Measured document replacement took 3 to 5 seconds. Earlier 20 to 30 second estimates were discarded as invalid runner artifacts, and `exec-js` A/B results remained unverified.

## <a id="build-clean-deletes-sole-copy"></a>`build clean` deletes sole build artifacts (2026-09-04)

- Cause: Switching user profiles from `PIPE_TAIL_USER` to `hsng9` lost toolchain paths. `npm run build` deleted `dist/` first and then failed at the Go step, wiping `dist/zeroproxy-server.exe` and breaking browser verification.
- Rule: Verify `go`, `wasm-bindgen`, `cargo`, and `node` before running a clean build. At the time, `taskweaver` was copied to `~/.cargo/bin` and Go was installed per user; `wasm-bindgen-cli --version 0.2.122 --locked` must match the `Cargo.lock` version.
- Related trap: Shell `PATH` values can remain stale after installation. Check the filesystem and `[Environment]::GetEnvironmentVariable("Path","Machine")`, or add `/c/Program Files/Go/bin`. Do not judge background builds complete by checking pre-existing output files that a subsequent clean step will delete; wait for task completion notifications.
- Variant (2026-09-10): When a running server locks the executable, clean deletes `dist/web/*` first and aborts with `EPERM` when unlinking `dist/zeroproxy-server.exe`, leaving a partial `dist/`. Run `Get-Process zeroproxy-server | Stop-Process` before building.
- Related trap: `npm run build 2>&1 | tail` returns the exit code of `tail`, making a failed build appear as `exit 0`. Enable `set -o pipefail` or run without piping.
- Recurrence (2026-10-02): A concurrent `rustup upgrade stable` in another terminal temporarily removed `cargo` (`the 'cargo.exe' binary ... is not applicable`), causing `npm run build` to abort after wiping `dist`. Because the compiled WASM in `target/` remained valid with unchanged Rust sources, the build was recovered by verifying source freshness and placing a no-op `cargo.exe` stub at the front of `PATH`, then rebuilding normally once the toolchain upgrade finished. Always verify `cargo --version` before building.

## <a id="worktree-junction-node-modules"></a>Running `worktree remove --force` on a worktree with a `node_modules` junction wipes the main repository `node_modules` (2026-10-02)

- Symptom: To compare against an older commit, `git worktree add <tmp> <sha>` was created with `node_modules` linked to the main repository via a directory junction before running `scripts/build.mjs`. During cleanup, `git worktree remove --force` followed the junction and deleted the contents of the main repository `node_modules`. Force removal was run without verifying that `cmd /c rmdir` had unlinked the junction after a quoting error caused `rmdir` to fail.
- Recovery: Restored dependencies with `npm ci` and re-verified `test:js` (126), WASM (13), and E2E (196/196).
- Rule: When building an older commit, do not link `node_modules`; extract the tree into a temporary directory with `git archive <sha> | tar -x` and run `npm ci` (or copy `node_modules`). If a junction is used, verify with `ls` that the link is removed before deleting the worktree.

## <a id="dead-browser-passes-all-checks"></a>`rendercheck` reported 4/4 OK after running for 13 minutes with a dead browser (2026-09-10)

Running the build, measurement, and `rendercheck` batch while the `taskweaver` daemon was stopped (`taskweaver list` returned `count: 0`) produced:

```
https://www.naver.com/ | title=? | raw=? csp=? err=?
    height ? / ? = ?%   els ? / ?   aboveFold ? / ?   styleEntities ?  => OK
```

All four sites printed `=> OK`. The verdict logic skipped every `?` value and appended `[ -z "$FLAG" ] && FLAG=" OK"` at the end, treating unmeasured runs as passing.

### Fix

Check that all measurement values exist before evaluating thresholds. Mark the run as `NO_MEASUREMENT` if any metric is empty or `?`.

```sh
for V in "$PH" "$CH" "$PE" "$CE" "$PA" "$CA"; do
  case "$V" in ''|'?') FLAG="$FLAG NO_MEASUREMENT"; break;; esac
done
```

Verified that the script returns `=> NO_MEASUREMENT` when the daemon is stopped and `=> OK` when the daemon is running.

### Rules

- Check `taskweaver list` for `id: "zp"` and `renderer_ok` before running batch measurements.
- Separate the unmeasured state (`NO_MEASUREMENT`) from `OK` in measurement evaluators so tool failures never report false passes.

## <a id="e2e-launcher-wait"></a>WebTransport worker E2E timed out once after 105s in CI and passed on rerun of the same commit (2026-10-01)

- Symptom: Only the worker variant in `wt-gateway.test.js` failed with `(no result)`. Both the 45s navigation wait and the 60s result wait expired, and gateway logs showed no session. The page variant and the other 190 tests in the same job passed, and rerunning the commit passed.
- Hypothesis (unconfirmed): The launcher disables the Open button until the Service Worker runtime is ready, and its submit handler returns early with `"Runtime is still loading"`. Clicking without waiting for button activation in a fresh browser context on a slow runner can skip navigation and gateway session startup (not reproduced locally).
- Action: Consolidated the launcher flow into `test/e2e/launcher.js` to wait until the Open button is enabled and return whether navigation occurred. On failure, WebTransport tests now log the page URL, body, `pageerror`, console output, failed requests, and worker creation state.
- Rule: Include the exact stage that stalled (page load, worker creation, or gateway) in E2E assertion failure messages. On a single CI failure, rerun the same commit (`gh run rerun --failed`) first to check for flake before debugging.

## <a id="e2e-goto-wait"></a>`page.goto` intermittently hung in the E2E new-page helper even though the page was already complete (2026-10-02)

- Symptom: Multi-frame E2E subtests intermittently hung inside `fresh.goto(proxy)` until hitting the 420s timeout.
- Measurement: Inspecting the hung browser via `--remote-debugging-port` showed the new page at `readyState: complete` with the `ZeroProxy` shell and active Service Worker control, while only `goto` failed to resolve. Request logs showed the `/zp/` request without a matching response event, while the server answered `curl` immediately.
- Cause (inferred): Puppeteer lifecycle waiting can miss completion on shell navigations answered by the Service Worker.
- Action: Updated the launcher helper (`test/e2e/launcher.js`) to wait for launcher button activation (runtime readiness) instead of waiting for `goto` resolution. Verified 6 consecutive scratch runs and 2 consecutive full E2E runs passing.
- Rule: Wait for observable page readiness in E2E helpers rather than `goto` promise completion. When a silent hang occurs, check the server (`curl`) and browser (`--remote-debugging-port`) states separately first.

## <a id="lexical-standin-2026-10-27"></a>Dependabot: `lexical` 6 is pinned by every `swc_css_parser`, so the crate is replaced, and the real one made the CSS parser panic (2026-10-27) {#lexical-standin-2026-10-27}

- **Alerts:** two, low severity, both in Cargo.lock: GHSA-c2hm-mjxv-89r4 (`lexical` <= 6.1.1, fixed in 7.0.0) and GHSA-2326-pfpj-vx3h (`lexical-core` < 1.0.0). API-level soundness issues in the crate's `unsafe` (`Bytes::read`, `BytesIter::read`, `write_float`, `radix`); no exploit through `parse` of plain decimals is known, but the crate stays in the build until it is removed. The only dependent is `swc_css_parser`, which parses the numbers of the stylesheets of the target.
- **Why not bump:** `swc_css_parser` 23, 24, 25 and 26 all require `lexical ^6.1`, so no release of the parser reaches `lexical` 7.
- **Fix:** `third_party-lexical/` (version 6.1.2, so the `^6.1` requirement is met) is `lexical::parse` and nothing else, on the standard library's number parsers, wired in with `[patch.crates-io]` like the other `third_party-*` crates (its UPSTREAM file has the details). `cargo update -p lexical` was needed for the lock to follow: with the old entry locked, cargo reported the patch as `unused`. Cargo.lock lost `lexical`, `lexical-core`, `lexical-parse-float`, `lexical-parse-integer`, `lexical-util`, `lexical-write-float` and `lexical-write-integer`.
- **Checked against the real 6.1.1 on 1.5 million inputs:** `f64` identical bit for bit (CSS numbers up to 400 digits, with sign, fraction and exponent). `i32` identical within range; outside it the real crate wrapped (`6255912584` gave 1960945288) or returned an error, and the stand-in clamps.
- **A defect the real crate had, now gone:** `swc_css_parser` answers a `lexical` error with `unreachable!`, so `li:nth-child(99999999999n+99999999999)` panicked the stylesheet rewrite (a wasm trap, and the stylesheet was lost). The unit test `numbers_and_nth_offsets_out_of_range_do_not_panic_the_parser` (zp-css) fails with the real crate (`failed to parse 99999999999 using lexical: Overflow(10)`) and passes with the stand-in.
- **When to remove it:** when `swc_css_parser` depends on a `lexical` without the advisories (or on none), delete the directory, the `[patch.crates-io]` line, the `exclude` entry and the paragraph in the root manifest.
