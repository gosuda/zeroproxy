# ZeroProxy — handoff (2026-10-13)

Written for: the next session (agent or engineer) picking up ZeroProxy cold. Read [CLAUDE.md](CLAUDE.md) and
`head -40 .ai/trap-notebook/INDEX.md` first; this file only adds what is not already there.

## Scope (decided 2026-10-14 — read before choosing work)

The project guards **containment** (no native networking for target code; no real window/Location/clean realm; no reach into
another target or the control surface; nothing unrewritten runs) and **compatibility** (sites that open natively open here).
Hiding the proxy from the page's own JavaScript is **not a goal**; the masking already in place stays, nothing new is started
on it. The rule is in [CLAUDE.md](CLAUDE.md) ("범위") and the ERRATA header. Before taking a task, ask which containment rule it
protects or which site it opens; if neither, leave it. This is why Glassdoor's challenge, eval stack text and the readable
strings below are closed as *not doing*.

## State

- Branch `main`; everything up to `a0c81d5` (the scope rule and the isolation audit, items 93) is on `origin/main`. The commit carrying this
  version of the file (items 94–104) is local until the user says to push.
- Commits of this arc: `8c178a7` HLS / loop cap / `innerHTML` / TLS refresh (ERRATA 58–61) · `8565ccf` five divergences found
  chasing the challenge (62–65) · `3ae6135` **Stack Overflow's Cloudflare challenge fixed** — the ClientHello lacked Chrome's
  `trust_anchors` extension — plus `Sec-Fetch-*` for frames and sub-requests (66–67) · `f8bb56a` element-load `Sec-Fetch-*`,
  `sendBeacon` as `no-cors`, `scripts/check-chrome-hello.mjs` · `8fc8a35`/`778955c` TaskWeaver notes · `d54c7f1` worker scripts
  told as `same-origin`/`worker`, `sec-fetch-storage-access` on cookie-carrying cross-site sub-requests (67), **workers under a
  `COEP: require-corp` document start** (68) · `5e1b775` meta CSP with entity quotes (69), native inline-script stacks (70) ·
  `3044044` a plain call's `this` (71), `Object.keys(window)` / location accessors (72), deterministic canvas/audio
  farbling (73), `Error.prepareStackTrace` as the page's own (74), `document.referrer` from the navigation (75), prelude
  scripts removed (76), **`eval(TrustedScript)` runs — the Glassdoor crash** (77), and **an escape closed: non-string timer
  handlers ran unrewritten** (78) · `5ee0b34` **the worker realm made native** — hook sources, hook placement on
  `WorkerGlobalScope.prototype`, our names, resource timing, `this`, brands (79) — and the page's navigator/resource-timing
  leftovers (80) · the latest commit: **client hints negotiated as Chrome does** — `Accept-CH`, the `Critical-CH` restart,
  the persona's build as the full version, Chrome's header order per request kind kept by the kernel, a runtime fetch's
  defaults (81) — **a fetch that cannot connect is a network error**, not our 502 page (82), an icon link never carries a
  fetchable URL (83, the favicon flake), a cross-origin frame reads its own feature policy and permissions (84), and the
  membrane's member access reads data bases directly (85) (`c8c0efa`) · **an escape closed — the page
  could answer for the helpers rewritten code hands the real window** (a binding, a write, its own `with` object, an
  attribute handler's scope; 86), and the rewritten VM made fast: helper names bound inside every runtime `with` (87),
  computed members kept native behind inline guards (88), dynamic code not rewritten again (89); an empty external
  script no longer throws (90) (`2fc889d`) · the latest commit: **an escape closed — the membrane read a window's own
  accessors (`frameElement`, `parent`, …) through whatever getter the page put there**: the page got the real window back,
  and a sandboxed frame that redefined its own `frameElement` navigated the top window (91) (`8e9d936`) · the latest commit:
  **a direct `eval` sees its caller's bindings** in a frame the page writes into and in strict code (92) (`82332eb`) · the latest
  commit: **the membrane's tables sealed against a page that wraps `Map`/`Set`/`WeakMap`/`WeakSet`** — it saw every key and value
  the membrane stored, and a wrapper that read a global variable recursed until the page died (93) (`a9edf11`) · the latest
  commit: **Reddit's reCAPTCHA errors traced to their roots** — a cross-origin window did not answer for the names of its child
  frames (94) and a worker answered to `window`/`top`/`parent` so libraries took it for a page (95).
- Verification (`2fc889d`): cargo 317 / 3 ignored, go ok, test:js 165, test:wasm:ci 15, static-policy 62, test:e2e
  231; the 705 cached corpus scripts rewrite to code V8 parses. 13-site sweep: all answer; Wikipedia, GitHub, Guardian,
  MDN, Naver, Apple, npm 0 errors; NYT back to its 2 (a 404, FedCM) once item 90 landed. Known noise, unchanged: BBC's
  GPT `t.getSlotElementId is not a function` (Google's ad tag) and one message-less uncaught, CNN's ad-partner 502s and
  sandboxed `about:blank` ad frames, Stack Overflow's 429s, Reddit's reCAPTCHA worker (`reading 'body'`, step 5). The
  sweep found two of this round's bugs that every test passed (`else0`, item 88; the empty script, item 90): run it.
  Item 91 (web only): test:js 165, test:e2e 232; both new checks fail with the plain reads restored. Item 92 (web only):
  test:js 165, test:wasm:ci 15, static-policy 62, test:e2e 233; the new check differs in 15 of its 36 cases on the build
  without the change (item 92). The 13-site error sweep was A/B-ed against the previous commit's build on CNN and Stack Overflow:
  the same errors (CNN's IMA SDK origin check, Stack Overflow's two OXC `Expected \`;\`` throws), nothing new.
  Item 93 (web only): test:js 167 (two new guards), test:wasm:ci 15, static-policy 64, test:e2e 234; the new e2e dies with a stack
  overflow on the unsealed build. The 13 sites were A/B-ed against the previous commit's build again: the same errors on both
  sides (CNN and Stack Overflow vary run to run on both), and a lookup/eval/`Function`/member/storage micro-benchmark is within
  its run-to-run spread (free-name lookups 292–319 ms before, 297–319 ms after).
- Detail lives in [ERRATA.md](ERRATA.md) items 62–104 and its Residuals table, the trap-notebook entries
  (`.ai/trap-notebook/rewriter.md`: `동적-코드-전역-this`, `chrome-hello-trust-anchors`, `coep-워커-부트스트랩`,
  `lol-html-원시-속성값`, `trusted-script-는-코드`, `워커-훅-자리`, `캔버스-파블링-결정적`, `prepare-stack-trace-페이지-뷰`,
  `프렐류드-스크립트-잔존`, `referrer-한-곳에서`, `클라이언트-힌트-협상`, `전송-실패는-네트워크-오류`, `대조군은-quic`, `바쁜-렌더러는-진다`, `아이콘-링크-경주`, `교차-출처-프레임-권한`, `헬퍼-이름-응답`, `with-안의-이름`, `인라인-가드`, `같은-소스-재리라이트`, `부모-파사드로-부팅한-자식`, `창-자기-접근자`, `strict-eval-with-안`, `봉인된-표`, `워커-전역-이름`, `교차-출처-창-자식-이름`), and the verification table in [PHASE2_STATUS.md](PHASE2_STATUS.md). No gate
  in PHASE2_STATUS is open.
- **A product decision was made without asking — flag it to the user:** the canvas/audio masking (ERRATA Q6, "intentional")
  stayed, but became deterministic per profile and origin (item 73). Removing it outright would be the other choice; the
  Glassdoor experiment showed it is not what decides that verdict.

## Next steps (suggested, in order)

1. **Ask before pushing.**
2. **Persona drift.** The persona is Chrome 154. Run `npm run check:chrome-hello` after a Chrome update: it opens the installed
   Chrome against a local listener and compares its ClientHello extensions and `trust_anchors` body with the SW's
   `CAPTURED_FINGERPRINT_B64` and `third_party-rustls-fork/src/ja3.rs` (exit 1 = drift, 2 = no Chrome). Bump the persona
   (`web/zp-core.js` — the major and the build, `TARGET_CHROME_FULL_VERSION`, read off the installed Chrome's
   `navigator.userAgentData.getHighEntropyValues(['uaFullVersion'])` — `web/worker-prelude.js`, the spec, the constant) together;
   `crates/zp-kernel-bundle/tests/client_hello.rs` pins the result.
3. **Glassdoor — open, reopened 2026-10-14 at the user's report** (a person ticks the box, sees "verifying", is asked again). It is a
   compatibility failure — a check a person passes natively that the proxy fails — so it is in scope; spoofing is not, and nothing
   here spoofs. Measured with a person's steps (`.lean-ctx/gd-phase.js`) and recorded in the ERRATA Residuals row: the challenge's
   script takes its retry branch after the click (it never builds the form natively posts; `cf_clearance` is issued and sent, the next
   `GET /` is 403). Ruled out by measurement: speed, latency, cookies, forms, input events, canvas/audio masking, the Trusted Types
   and `pushState` probes (matched; ERRATA 96), Resource Timing initiator types, the window attributes the challenge redefines (97), the
   cross-origin refusal sentences (98) and the shape of the built-ins (99) — the last three from a 273-key survey of what the challenge page and
   its widget read about themselves (`.lean-ctx/gd-survey.js`, then `gd-survey-diff.js`), and ERRATA 100–101 from the payload itself, read with a debugger
   breakpoint on `XMLHttpRequest.send` (`gd-pause.js`; `gd-table-diff.js`, `gd-fields.js`). With those fixed the VM's property table matches native in every group and the
   outcome is unchanged; stack positions are not part of the verdict (`gd-shift.js`). What is left: the time profile (the VM's phases run 3–4× slower; the membrane's
   self time is more than the challenge script's — per-operation loops found four paths 20–680× native (toString, `document`, `location.href`, plain-object members) and the inline-script `with` at 132×, ERRATA 103 and
   its residual rows; fixing the three left the spans and the outcome unchanged) and what the server sees that the page cannot. **2026-10-15: the transport is cleared.** A native page whose requests are all answered by the proxy's
   own kernel passes the challenge in 13 of 13 runs (after a harness bug — an empty form-POST body — was fixed) (`.lean-ctx/gd-phase-bridge.js bridge`; ERRATA Residuals, first Glassdoor row), so HTTP/3 and the TLS/HTTP-2 stack are not
   it, and neither are the persona's Accept/Referer/header-order differences (added to the passing run one by one: still passes). The cause is in the page-side layer.
   **2026-10-15, later: the challenge a person is given, and the widget's own answers.** `window._cf_chl_opt.cType` (`gd-ctype.js`): Chrome over HTTP/3 gets `managed` (passes by itself) every time, over
   HTTP/2 about half, the proxy's kernel never (7 counted runs, every other run showed the checkbox) — the wire a probe can read is equal (`gd-echo.js`: JA4, extensions, H2 frames, TCP/IP), so HTTP/3 is what makes it reliable. The person then ticks the checkbox and
   passes natively but not through the proxy: the parent's final payload carries the widget's `error` / `600010`. The widget's payload (read after the click with a breakpoint on `XMLHttpRequest.send`,
   `gd-pause2.js`; an attached debugger spoils the native parent, so only the widget is read natively) is 38 probe stages with a wall time and a categorical answer each. Compared stage by stage:
   fixed in ERRATA 104 — the built-in AI, ~20 policy-gated APIs and the sensors/PaymentRequest constructors in a cross-origin frame, WebGL's low-power preference there, XML `outerHTML`
   (the payload fields now equal native's; the outcome is unchanged). Found, measured, not done (Residuals): the target's CSP is not applied (the widget counts its Trusted Types `default` policy
   being called 43 times natively, 0 proxied), `connection.rtt` is 0, audio noise is detected (the proxy's `getChannelData` farble: with it off the audio hash equals native's; **your call whether to keep it**),
   inline-script entity decoding, the stage timings (sum 1.4 s native, 6.7 s proxied). Method that found them: per-stage membrane operation counts (a temporary `get`/`set` bucket counter keyed by the stage's own
   `ncMr7..RCCiX6` window) and native-vs-proxied probes of one API family at a time (`gd-gated-apis.js`, `gd-webgl-attr.js`, `gd-ai-avail.js`, `gd-parser-cmp.js`, `gd-tthook.js`). **The inverse experiment is done**:
   `gd-inverse.js` made the native-page+kernel run (which passes) behave like the proxied one a factor at a time (`INVERSE=ai|gl|gated|audio|rtt|csp|csp-all|all`, `N=3`, `CPU=5`, `VERIFY=1`): each factor passes 3 of 3, all of them together pass 3 of 3, also at a 5× CPU slowdown —
   so none of the differences above is the cause, and Trusted Types enforcement is **not** worth building for this (it would be a feature, not the fix). Candidates left, none tested: the timing profile's shape (non-uniform: the membrane makes some operations 100× and others 1×),
   Resource Timing lists, the real process boundary (the widget is an out-of-process frame natively; one process and one origin underneath here — a per-virtual-origin real origin would hand the browser the whole class of checks of ERRATA 104), HTTP/3 (makes the challenge `managed`).
   Open question for the owner: keep or drop the `getChannelData`/canvas noise (detected by the widget, changes no verdict). Other tools: `gd-proxied-trace.js` (kernel calls recorded in the SW), `gd-phase.js native|proxied`.
   Measured Resource Timing gaps worth fixing on their own (an XHR is `fetch`, a `<link>` load is `img`, a cross-origin frame's
   entry shows `h2`/sizes) are in the same row.
4. **Not doing:** a page's own `eval` / `new Function` code prints as a script frame, not V8's eval-origin text (ERRATA
   Residuals). Matching that text exactly needs a unique sourceURL per eval, the caller's position at compile time and column
   remapping; the only reader it serves is a script that tells environments apart by the text of its own eval stacks (bot
   scoring), so it stays a residual. Persona drift was checked 2026-10-13 (`npm run check:chrome-hello`: Chrome 154.0.8037.98,
   17 extensions, `trust_anchors` 186 bytes — matches).
5. **Accepted, not doing:** the strings the membrane handles are visible to a page that patches `String`/`RegExp`/`Array`/`JSON`
   methods (ERRATA Residuals, first row; measured 2026-10-13 with `.lean-ctx/spy-bisect.js`): the proxy origin, the page's own
   share URL with its `#k=` key, the relay pipe, tab/entry ids, its own request URLs. No real window or Location object was seen;
   the tables that hold them are sealed (item 93). Closing it would take a captured native at every string/array/JSON call
   (thousands of sites) or a realm of its own for the membrane, for something that is concealment. Decided 2026-10-14: not closed.
   Both follow-up checks were run 2026-10-14: cross-site frames and popups under every spy group leak no real window/Location, and
   built-ins wrapped by a global-reading function never kill the page unless the wrapper itself is made by `new Function`/`eval`
   (3 of 27: `Reflect.set`, `Reflect.getOwnPropertyDescriptor`, `RegExp.prototype.test`; ERRATA Residuals, first row) — accepted,
   no known site. Tools: `.lean-ctx/spy-bisect.js` with `page-spy-groups.html` (spies) or `page-wrapglobal.html` (wrappers),
   `wrap-report.js` and `spy-report.js` for the verdicts.
6. **Closed 2026-10-14:** Reddit's reCAPTCHA errors had two roots, both fixed — the challenge frame's `parent['a-…']` (ERRATA 94) and the
   worker's `document.body` (ERRATA 95: the proxy's worker answered to `window`). Reddit still serves its own "Prove your humanity"
   interstitial; passing it is not ours to do (scope). Five loads after the fixes: the worker runs, no exception in any target.
   Lab tool: `.lean-ctx/reddit-targets.js` (lists targets, exceptions with stack and source around the position).

Done this round and closed: items 71–104 (see State); before that the meta-CSP lone `'` (69), the inline-script stack (70),
Reddit (parity re-checked with a fresh unautomated Chrome — same wall natively).

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

## TaskWeaver (browser CLI, now 0.19.0)

The user fixed what was asked for last session. Verified in use: `exec-js --target sw`, `nav-log` (per-hop timeline incl.
frames and blocked reasons — it is how the COEP block was found), `failed-requests`, `--field`/`--jq`/`--raw`, and `list`'s
new `current_url` / `last_used` / `engine` / `profile` fields. Exercised afterwards (results below): `console-logs` across
frames, `cookies list|clear`, `reset`, `record on|off`. Not exercised: `--private-profile`, **`--engine chrome`**.

### Requests for TaskWeaver (measured 2026-10-08 on 0.18.0, Windows/WebView2, instance `zp`)

For whoever works on TaskWeaver. Each item says what was run and what came back.

**Re-checked 2026-10-12 on 0.19.0 — same repro, same instance (`zp`, shared profile):**

| # | 0.19.0 result |
|---|---|
| 1 | **Fixed.** The cross-site frame's lines are captured: with `--console-buffer 5000`, 700 + 20 `debug` and both errors from the `127.0.0.1` frame, the same from the same-origin frame, the parent's 5, `dropped: 0`. `console-logs --frame <frame_id>` returns only that frame's lines, `--text` filters by message. |
| 2 | **Fixed.** `start --console-buffer N` sets the ring (`buffer_size` in the response); with the default 500 the response said `dropped: 949`. |
| 3 | **My mistake, not a TaskWeaver bug.** The field is `http_only` (snake_case — now said in `cookies --help`); I had read `httpOnly`, which does not exist, hence `null`. It reads `true` for `top_http`/`child_http` and `false` for the visible ones; `host_only`, `same_site`, `priority`, `source_scheme` are there too. |
| 4 | **Fixed.** On the shared profile with `zp` the only daemon, `cookies clear --all` and `reset` both answer `SHARED_PROFILE` and delete nothing (the jar still had its 9 cookies). `--dry-run` reports what each would do; `--force-shared` / `reset --keep-browsing-data` are the ways through. |
| 5 | **Fixed enough.** After `record off` the response carries `recording: "off"` and `enabled: false`; `list` shows `record: false`. `armed` stays `true` (the transport stays attached). |
| 6 | `--jq` now runs `sub(...)` and `capture(...)`; a `\d` the shell had halved is reported with an explanation instead of a parse error. `start --ttl 45s` made `zp` stop itself after 45 s (`ttl_s` in `start`/`list`), so a short-lived `--engine chrome` instance is possible — the one-instance policy in CLAUDE.md still says `zp` only. Busy page: not reproduced — a page spinning in a `while` loop still answered `exec-js` in this test, so that item stays open as unverified. `exec-js --frame 5` on a page with no frames answers `FRAME_INDEX_OUT_OF_RANGE` with `dom_frame_count`. |

Original report (0.18.0) follows.

1. **`console-logs` collects nothing from a cross-site frame.** Repro: a page on `http://localhost:PORT/` that appends an
   `<iframe src="http://127.0.0.1:PORT/child">`; the child runs `for (i < 700) console.debug(...)`, one `console.error`
   at once, and 20 more `console.debug` + one `console.error` after `setTimeout(…, 1500)`. `console-logs --max 1000` returned
   the parent's 5 lines and **none** of the child's — not the early ones, not the late ones, not the errors — while
   `get-frames` listed the child (its `frame_id` was known). A second, same-origin `<iframe src="/child">` on the same page
   *was* captured (with `frame_id` and `url` per entry). So: capture reaches the top frame and same-origin frames, not
   cross-site (out-of-process) ones. This is what blocked using TaskWeaver to trace Cloudflare's widget, which is a
   `challenges.cloudflare.com` frame. Wanted: capture from every frame target, plus `--frame` and `--text` filters.
2. **The console buffer is a 500-entry ring and drops the oldest.** In the same run the parent's 5 lines were evicted once the
   same-origin frame had logged 500. Fine as a default; wanted: a start flag for the size, and the response saying how many
   entries were dropped.
3. **`cookies list` reports `httpOnly: null` for every cookie.** The server set `top_http=1; HttpOnly` and `top_vis=1` (and the
   same pair from the frame); all four were listed with the right `domain`/`path`, all with `httpOnly: null`. HttpOnly cookies
   are included — the flag just is not filled, so they cannot be told apart.
4. **`reset` and `cookies clear` wiped the shared profile without asking.** The help says both refuse on a shared profile
   unless `--force-shared`; the check is "another live daemon shares it". With `zp` the only daemon, `list` showing
   `profile.kind: "shared"` (`…\com.pipestudio.taskweaver\EBWebView`), `cookies clear` deleted 6 cookies and `reset` cleared
   the browsing data, no flag needed. The profile outlives the daemon and other sessions use it later, so "no other daemon is
   up right now" is not "nobody else uses it". Wanted: refuse on `kind: "shared"` unless `--force-shared`, and a dry run that
   lists what would be deleted. (Nothing of value was lost this time — the only cookies were the test ones — but the storage
   that `reset` cleared cannot be inspected after the fact.)
5. **`record off` leaves `armed: true`.** `record on` → `arm_verified: true`, 88 network events for one navigation; after
   `record off`, `armed` stays `true` and the off state is only in `enabled` / `stopped_at_ms` / `off_periods`. Confusing
   when `armed` is the field `list` and the docs point at.
6. Smaller:
   - `--jq` rejected `sub("…")` with a regex and `capture(...)`; a line in `--help` naming the supported jq subset would do.
   - On a page busy computing a challenge, evaluating in its frames timed out (seen with puppeteer's `evaluate`, not tried with
     `exec-js --frame`); if `exec-js` behaves the same, telling "renderer busy" from "no such frame" would help.
   - `--engine chrome` is ruled out here only by the one-instance policy; a lifetime bound (`--ttl 10m`, or stop with the
     parent process) would let a Chrome-side comparison run without a second long-lived instance.

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
- **A full e2e run that "fails" only with `test timed out` on the E1 block and `cancelled` children ran out of budget, it
  did not find a bug.** The block took 358–367 s of its old 420 s; it is 720 s now (outer test 900 s). Before suspecting
  code, diff per-test durations against the last green log, then A/B the slowed tests on the previous `web/` (stash,
  `--web-only` build, same scratch subset) — on 2026-10-12 that read 185 s vs 193 s: noise.
- **The `favicon masking` flake was a race, fixed (item 83):** the parser reports an icon to the browser before the
  membrane's observer can hide it, so htmltx now writes the hidden href itself. A flake that repeats is a race until shown
  otherwise.
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
- **`taskweaver reset` / `cookies clear` on the shared profile:** on 0.18.0 they ran when `zp` was the only daemon; 0.19.0
  refuses (`SHARED_PROFILE`). Still use `--dry-run` / `reset --keep-browsing-data` rather than reaching for `--force-shared`.
- **`taskweaver upgrade` stops every daemon**, `zp` included — restart it (`taskweaver list` first; another session's instance,
  e.g. `p151`, may be running: leave it alone).
- **Never `taskkill //IM chrome.exe`.** It closes the user's own Chrome (happened once). Filter by command line
  (`Get-CimInstance Win32_Process`, `zp-fresh-` in the user-data-dir).
- **puppeteer element-handle calls hang when attached to a self-started Chrome** (since 2026-10-12, Chrome 154 + puppeteer
  25.0.4): `page.click` / `page.type` time out in `Runtime.callFunctionOn` even on example.com, while `page.evaluate` works.
  The `.lean-ctx` scripts now fill and submit the launcher through `page.evaluate` — a run that "never leaves the launcher"
  is this, not the proxy.
- **A spec sentence about "a string" may mean "what the host treats as code".** The membrane's `eval` returned a
  TrustedScript unevaluated (PerformEval step 1), and its timers passed non-string handlers to the native timer, which
  compiled them unrewritten (items 77–78).
- Commits: Korean message through `git commit -F file` (or PowerShell), **no** `Co-Authored-By`/"Generated with" trailers.
