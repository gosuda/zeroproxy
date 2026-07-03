# TLS Fingerprint Trap Notebook

ZeroProxy 의 client-TLS 스택 (rustls 0.23 + rustls-rustcrypto, WASM linear-memory)
에서 발견한 JA3 / JA4 / Akamai-H2 / Padding / ECH GREASE 관련 함정과 anti-bot WAF
실측 결과 기록.

상위 plan: PHASE2 strict mode "탈출 없는 감옥". client-TLS 가 서버로 누출되지 않는
것이 첫 번째 invariant — 모든 fingerprint mimicry 는 그 invariant 안에서.

---

## 2026-07-03 — NAVER tarpit 근본 원인: `is_grease_value` 비트버그로 extension GREASE 가 wire 에 안 나감 + version GREASE 를 encode() 에서 random 호출 → resumption binder DecryptError

**Symptoms (사용자)**: "그냥 접속하면 잘되는데 아이피 제한이 무에 소용이야" — 같은 IP 로
real Chrome 직접 접속은 즉시 되는데 ZP 프록시 경유 NAVER 만 body 가 33~70KB 에서
멈췄다가 2~4분 뒤 나머지가 burst. 이전 세션들이 "IP/reputation tarpit" 으로 오진.
IP 가 아님이 사용자 지적으로 확정 → wire fingerprint 재검증.

**측정 (tls.peet.ws/api/all, ZP vs real Chrome 148)**: h2/akamai_hash 동일, ja4 동일
(→ Wikipedia/ja4-기반 사이트는 통과) 이지만 **ja3_hash, peetprint_hash 불일치**. 필드별:

| peetprint 필드 | Real Chrome | ZP before |
|---|---|---|
| supported_versions | `GREASE-772-771` | `772-771` (GREASE 버전 없음) |
| extensions | `…GREASE…GREASE` (양끝) | GREASE 전무 |
| cert_compression | `2` (Brotli) | `2-1` (Brotli+Zlib) |

**근본 원인 1 — `is_grease_value` 비트버그 (ja3.rs)**: 판정식이
`(v & 0x0f0f) == 0x0a0a && (v & 0xf0f0) == 0xa0a0`. 두 번째 항이 두 바이트 **상위**
니블까지 0xA 를 요구 → 16개 GREASE 값 (`0x0a0a…0xfafa`) 중 **`0xaaaa` 하나만 통과**.
`encode_one` (macros.rs:227) 의 GREASE fast-path 가 이걸로 걸러 zero-length 확장을
emit 하는데, `random_grease()` 가 뽑는 값의 15/16 이 false → **extension GREASE 가
조용히 drop**. cipher/group GREASE 는 list 본문 인라인 값 (`CipherSuite::Unknown` /
`NamedGroup::Unknown`) 이라 이 predicate 를 안 거쳐 살아남음 → "일부 GREASE 만 있는"
불완전 상태. NAVER raw fingerprinter (ja3/peetprint, ja4 와 달리 GREASE 안 벗김) 가
"Chrome 이라면서 GREASE 불완전" 을 봇으로 판정 → 그 연결만 서버측 tarpit
(cologger.shopping.naver.com `http=125009ms` trace 로 확인).
**Fix**: `(v & 0x0f0f) == 0x0a0a && (v >> 8) == (v & 0x00ff)` (하위 니블 0xA + 두 바이트 동일).

**근본 원인 2 — cert_compression 초과**: rustls 가 `config.cert_decompressors`
(Brotli+Zlib) 에서 `certificate_compression_algorithms` 를 apply_chrome_ja3_shape
**보다 먼저** 세팅 → `is_none()` 가드로는 override 못 함. Chrome 148 은 Brotli 만.
**Fix**: apply_chrome_ja3_shape 에서 `is_none()` 가드 제거하고 무조건 `[Brotli]` 로
덮어씀 (offered_cert_compression 은 superset 이라 server 선택은 wire 의 Brotli 로 제한 → 검증 안전).

**근본 원인 3 (신규 회귀, 위 fix 후 노출) — version GREASE 를 encode() 에서 random**:
`SupportedProtocolVersions::encode` 에 `ProtocolVersion::Unknown(random_grease())` 를
넣었더니 www.naver.com resumption 에서 **간헐적 `fatal alert: DecryptError`**
("Could not reach target"). 원인: PSK binder 는 ClientHello 를 한 번 직렬화해 MAC 을
계산하고 wire 로 다시 직렬화하는데, encode() 가 매 호출 `random_grease()` 를 advance →
두 직렬화의 GREASE 버전이 달라 binder transcript 불일치 → 서버 DecryptError.
cipher/group/extension GREASE 는 apply_chrome_ja3_shape 에서 **한 번 계산해 struct 에
저장** 되므로 안전. **오직 encode() 안의 random 만 문제**.
**Fix**: 고정 상수 `ProtocolVersion::Unknown(0x0a0a)`. ja3/peetprint 는 GREASE 를
값 무관 "GREASE" 로 정규화 (그래서 Chrome 자신도 매 연결 random 이지만 hash 는 고정)
→ 고정값이어도 peetprint_hash 동일. **교훈: encode() 등 여러 번 불릴 수 있는 직렬화
경로에는 절대 RNG 를 넣지 말 것. GREASE 는 handshake 당 1회 계산해 저장.**

**결과**: peetprint_hash `1d4ffe9b0e34acac0bd883fa7f79d7b5` = real Chrome **완전 일치**.
NAVER 문서 `http=47ms` + `h2-stream-close out=259605` (전체 259KB 전송, 스트림 정상
종료) — **tarpit 소멸**. TLS 회귀 없음 (wikipedia/github/cloudflare 전부 tls-ok).

**남은 별개 이슈 (tarpit 이 가리고 있다 노출)**: 커널은 문서를 완전 전송/close 하는데
(`out=251983`) 브라우저 DOM 이 간헐적으로 33KB/interactive 에서 멈춤. trace 상
www.naver.com 문서가 **두 번 fetch** (첫 스트림 `h2-stream-cancel out=233680` → 재요청
`h2-stream-close out=251983`). SW streamDocumentResponse/HtmlTxn 렌더 경로 문제로
추정, fingerprint 와 무관. 별도 조사 필요.

---

## 2026-06-02 — Phase 5.8: captured spec 이 cipher 도 wire emit 하도록 fork 추가 수정, 헤더 순서 + UA 정렬, Chrome 148 spec 으로 baseline 업데이트. JA3 cipher tuple byte-equivalent Chrome 148 (`8daaf6152771`), nid.naver.com TARGET_CONNECT_FAILED → 정상 로드 회복

**Symptoms (사용자 challenge)**: "근데 정확한 브라우저 모킹은 수행한거야?" — 직전 모든
세션에서 "wire-level fingerprint 작업 끝났고 IP/cookie 가 진짜 원인" 으로 결론났지만
실제 wire 검증은 수행 안 했음. tls.peet.ws/api/all 로 ZP vs real Chrome 비교 즉시
의뢰 → 다음 큰 격차 드러남.

**측정 (Step c, tls.peet.ws via ZP vs direct browser)**:

| 항목 | Real Chrome 148 (Edge WebView2) | ZP before fix | ZP after fix |
|---|---|---|---|
| JA3 hash | `514ca29ce003491d9e5c04e62a51c125` | `bda02c9f5d21f960c643fd6f83526dfd` | `5779cc8a572776095cfb1d5a3e5b6733` |
| JA4 | `t13d1516h2_8daaf6152771_d8a2da3f94cd` | `t13d1017h2_61a7ad8aa9b6_27ad14494bd4` | `t13d1515h2_8daaf6152771_22334254f9f7` |
| Cipher count | 16 (15+GREASE) | 11 (9+GREASE+SCSV) | 16 (15+GREASE) |
| Cipher middle hash | `8daaf6152771` | `61a7ad8aa9b6` | **`8daaf6152771` byte-identical** |
| Cipher order pattern | AES128(ECDSA→RSA), AES256(…), CHACHA(…) interleaved | ECDSA all → RSA all (grouped) | interleaved ✓ |
| Extensions | 16 incl ECH 65037 | 16 incl record_size_limit 28 (Firefox!) | 15, no ECH, no 28 |
| supported_groups | GREASE+MLKEM+X25519+P256+P384 | X25519+P256+P384 | X25519+P256+P384 |
| User-Agent | `…Chrome/148 Safari/537.36 Edg/148.0.0.0` | `…Chrome/134.0.0.0 Safari/537.36` (Go-style) | `…Chrome/148 Safari/537.36 Edg/148.0.0.0` ✓ |
| Header order | sec-ch-ua → mobile → platform → upgrade → UA → accept → sec-fetch-* → … → priority | 알파벳 정렬 (accept, device-memory, downlink, dpr, ect, rtt, sec-ch-ua-arch, …) — Go map iteration | Chrome 148 sequence ✓ |
| h2 SETTINGS | `1:65536;2:0;4:6291456;6:262144` | 동일 | 동일 |
| h2 pseudo-header order | m,a,s,p | m,a,s,p (h2 fork) | m,a,s,p ✓ |

**진단**: Phase 5.7 의 "captured spec 설치"는 동작했지만 fork 의 client/hs.rs 에서
**cipher list 는 captured spec 무시**하고 `config.provider.cipher_suites` 사용. extension
order 만 captured spec 따라가고 ciphers 는 `chrome_ordered_cipher_suites()` (Chrome 134-time, 9-entry, ECDSA-then-RSA grouped) 그대로 emit. 즉 captured spec 의 "cipherSuites" 필드는
완전 dead code 였음. 또한:

1. SW 의 `headerEntries` 는 `headers.entries()` (Fetch spec: sorted lowercase) + `opt.request.headers.entries()` (sorted lowercase) → 결과 wire 가 알파벳 정렬 → 100% Go/Rust HTTP client tell.
2. SW 가 `device-memory`, `downlink`, `dpr`, `ect`, `rtt`, `sec-ch-ua-arch`, `sec-ch-ua-full-version[-list]`, `sec-ch-ua-model`, `sec-ch-ua-platform-version` 등 **Accept-CH grant 가 있어야만 Chrome 이 보내는 opt-in hints 를 무차별 forward** — Chrome cold-nav baseline 은 sec-ch-ua/mobile/platform 3개만 보냄. 추가 hints 는 100% bot signal.
3. UA 가 X-ZP-User-Agent → kernel 이 promoted_ua 로 분리 후 `headers_owned.push(("User-Agent", v))` 로 **list 끝에 append** → wire 에서 user-agent 가 index 11+ 위치 (real Chrome 은 index 4).
4. `TARGET_USER_AGENT` 가 `Chrome/134.0.0.0 Safari/537.36` (Go 식 Chrome 134 hard) — 페이지가 보내는 sec-ch-ua brand 는 `Microsoft Edge WebView2;v=148`, `Chromium;v=148` → 3-way mismatch (UA 134 ↔ sec-ch-ua 148 ↔ TLS preset 133).

**Fix (Phase 5.8)**:

1. [third_party-rustls-fork/src/client/hs.rs:392-410](../../third_party-rustls-fork/src/client/hs.rs) — `captured_ciphers` 가 있으면 `cipher_suites = captured_ciphers;` 로 wire override. provider.cipher_suites 는 그대로 (ServerHello 의 chosen cipher 매칭용); wire 에는 captured 15 ciphers (Chrome 148 interleaved order + legacy RSA fallbacks 49171/49172/156/157/47/53 decoys) emit. 모던 서버는 TLS 1.3 / ECDHE_GCM/CHACHA20 만 선택하므로 decoy 사용 안 됨.
2. 같은 파일 387-390 — `has_captured` 일 때 SCSV (255) skip (Chrome 148 은 renegotiation_info extension 으로 대체, SCSV 안 보냄).
3. 같은 파일 678-697 — `captured_has_padding || no_captured` 일 때만 Padding (id 21) 삽입. Chrome 148 은 MLKEM key_share 가 큰 ClientHello 만들어 padding 안 함. ZP 는 MLKEM 못 만들어 ClientHello 가 작아서 fork 가 자동 추가하던 padding 을 막아야 JA3 ext 가 16 → 15 (Chrome 148 ext 16 인 것과 1 차이 = ECH 만, padding 차이 없음).
4. [web/sw.js:495](../../web/sw.js#L495) — `capturedFingerprint` base64 를 Chrome 148 spec 으로 교체 (cipher 15-entry Chrome 148 order, ext 16-entry `0,17613,51,65281,43,16,5,11,13,18,23,27,10,35,45` (ECH 65037 제외), curves `[4588,29,23,24]` MLKEM 포함).
5. [crates/zp-bundle/src/kernel/transport/tls.rs:91-119](../../crates/zp-bundle/src/kernel/transport/tls.rs#L91-L119) — `chrome_ordered_cipher_suites()` 를 Chrome 148 interleaved order 로 재배열 (AES128 ECDSA→RSA, AES256 ECDSA→RSA, CHACHA ECDSA→RSA).
6. [web/sw.js:636-708](../../web/sw.js) — `DROP_CLIENT_HINTS` Set 으로 device-memory/downlink/dpr/ect/rtt/sec-ch-ua-arch/sec-ch-ua-bitness/sec-ch-ua-full-version/sec-ch-ua-full-version-list/sec-ch-ua-model/sec-ch-ua-platform-version/sec-ch-ua-wow64/viewport-*/save-data/prefers-* 전부 drop. `HEADER_ORDER` 로 Chrome 148 sequence 강제 sort (sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, upgrade-insecure-requests, user-agent, accept, sec-fetch-site/mode/user/dest, referer, accept-encoding, accept-language, priority, cookie). UA `pushOnce('user-agent', ZP.TARGET_USER_AGENT)` inline emit (X-ZP-User-Agent kernel append → SW headerEntries inline + sort 자리 잡힘).
7. [crates/zp-bundle/src/kernel/mod.rs:258](../../crates/zp-bundle/src/kernel/mod.rs#L258) — kernel filter 의 strip 리스트에서 `user-agent` 제거 (SW 가 inline emit + sort 하므로 더 이상 X-ZP-User-Agent → 끝 append 패턴 불필요).
8. [web/zp-core.js:22](../../web/zp-core.js#L22) — `TARGET_USER_AGENT` 를 `Chrome/148.0.0.0 Safari/537.36` 로 업데이트 (page-side 가 sec-ch-ua-brand 148 보내므로 mismatch 제거; 실 wire 에서는 page-side 가 자기 native UA `Chrome/148 Safari/537.36 Edg/148.0.0.0` 보내고 SW 의 `headers = new Headers(opt.request.headers)` 가 그것을 흡수 — pushOnce 의 TARGET 은 fallback only, page-side UA win 이 의도된 동작).

**검증** (Step d — nid.naver.com cold):

- ZP before Phase 5.8: TARGET_CONNECT_FAILED at 60-120s, 페이지 never loads.
- ZP after Phase 5.8: title "Naver Sign in" loaded at ~60-90s.
- Direct Real Chrome (same IP/network/time): nid.naver.com 30s, www.naver.com 15s.
- Diag trace: `tx:tls-ok host=nid.naver.com tls=48ms` (TLS handshake fast), `tx:h2-ok host=www.naver.com http=60052ms` (60s slow-lane 잔존 — 그러나 응답 도착, TARGET_CONNECT 아님).

**결정타 결론**: wire-level fingerprint 작업이 **여전히 valuable** — Phase 5.7 까지의 "wire fix 끝, IP 가 문제" 결론은 **wire 검증 미완으로 잘못 도출됨**. 실제 wire 는 Chrome 134-time grouped 9-cipher + Firefox-specific record_size_limit + Go-style alphabetical headers + Chrome 134 UA + sec-ch-ua brand 148 mismatch 였음. Phase 5.8 후 JA3 cipher tuple 이 Chrome 148 byte-identical, 그러나 ext (ECH 65037 absent) + curves (MLKEM 4588 emit 되지만 key_share 는 X25519 만) 의 small diff 남음. **NAVER WAF 가 IP-reputation 도 작용** (real Chrome direct 도 nid 30s 걸리는 사실로 확인).

**Phase 5.8 부록 3 — h2 HEADERS frame PRIORITY (0x20) flag + Chrome 148-style stream dependency emit**:

- 직전 measurement 에서 real Chrome 148 의 HEADERS frame 은 `flags: [EndStream(0x1), EndHeaders(0x4), Priority(0x20)]` + 5-byte dependency payload `{exclusive=1, dep_id=0, weight=256}` (wire weight byte=255). ZP 는 `flags: [EndStream, EndHeaders]` 만 — Priority field 누락. Akamai-style H2 fingerprint hash 자체는 SETTINGS+WINDOW_UPDATE+pseudo-header 만 hash 해서 동일 hash 산출되지만, **anti-bot WAF (NAVER nid, Cloudflare bot manager) 가 priority field 자체 존재 check**.
- **Fix**: h2 fork [third_party-h2-fork/src/frame/headers.rs](../../third_party-h2-fork/src/frame/headers.rs) 에 `Headers::set_priority(StreamDependency)` 메서드 + `HeadersFlag::set_priority()` 추가. encode 시 PRIORITY flag set 됐으면 `f` 콜백에서 4-byte (E flag + 31-bit dep_id big-endian) + 1-byte weight 를 HPACK 앞에 write (RFC 7540 §6.2). EncodingHeaderBlock::encode 의 길이 fix-up 이 자동으로 5-byte 를 payload length 에 포함. [client.rs](../../third_party-h2-fork/src/client.rs) 의 request frame 생성 직후 `frame.set_priority(StreamDependency::new(StreamId::ZERO, 255, true))` (weight 256 over wire = 255). [priority.rs](../../third_party-h2-fork/src/frame/priority.rs) 에 `weight()` / `is_exclusive()` 게터 추가 (encoder 가 private fields 못 봐서).
- **검증** (tls.peet.ws/api/all): ZP frame flags `[EndStream, EndHeaders, Priority(0x20)]`, priority field `{weight:256, depends_on:0, exclusive:1}` — Real Chrome 148 과 byte-equivalent. 회귀 매트릭스 (Wikipedia 3.2s / mail 3.2s / nid 63.4s / GitHub 35.7s) 모두 통과.
- **Pattern**: "akamai_fingerprint hash 가 동일하다고 wire 가 동일한 건 아님 — hash 가 일부 frame 만 cover" — priority field 는 그 hash 에 포함 안 되지만 anti-bot WAF 가 별도로 check.

---

**Phase 5.8 부록 2 — h2 body "bytes remaining on stream" 가 github.com hard fail 시키던 regression fix**:

- 회귀 검증 중 [GitHub cold load 가 31s 에서 TARGET_CONNECT_FAILED] 으로 종료. trace: `tx:h2-err host=github.com err=h2: body: bytes remaining on stream t=32802ms`. TLS handshake / h2 handshake / response headers 모두 성공, body stream 중 server 가 declared content-length 채우기 전에 stream 종료 → h2 crate 가 mid-body error 반환 → 전체 응답 폐기 → TARGET_HTTP_FAILED.
- Real Chrome 도 같은 30s 걸리지만 partial body 받아서 페이지 렌더 — graceful 처리. ZP 의 [http2.rs:213-225](../../crates/zp-bundle/src/kernel/transport/http2.rs#L213-L225) `body_stream.data().await` 가 `chunk.map_err(..)?` 로 즉시 propagate 했음.
- **Fix**: 에러 시 `body_buf.is_empty()` 면 그대로 propagate (zero-byte response 는 실제 fatal), 아니면 partial body break 후 정상 응답으로 반환. `tx:h2-body-trunc bytes=N err=...` trace 라인 추가하여 telemetry 보존.
- **결과**: GitHub cold 35.7s 정상 로드 (real Chrome direct 30s). h2 body truncation tolerance 가 Cloudflare/GitHub 같은 sites 의 "정상이지만 stream 조기 종료" 패턴 핸들링.
- **Lessons**: "wire mimicry 향상 후 회귀" 라고 단정 전에 stage-level trace 확인 의무 — 이 경우 TLS/h2 handshake 는 succeed, body 만 truncate. fingerprint 가 진짜 문제였다면 TLS/h2 hs 도 fail 해야 함. trace 가 "fingerprint 회귀 아닌 body handling 회귀" 라고 즉시 진단해줌.

---

**Phase 5.8 부록 1 — MLKEM supported_groups wire emit 시도 → nid.naver.com 즉시 깨짐 (revert)**:

- `apply_chrome_ja3_shape` 에 `exts.named_groups = Some(captured_groups)` 추가 시 wire 가 `supported_groups: [GREASE, 4588 MLKEM, X25519, P-256, P-384]` 로 변경, JA3 curves field `4588-29-23-24` Chrome 148 byte-equivalent. tls.peet.ws/api/all 통과 (서버가 X25519 fall-back 선택).
- 그러나 **nid.naver.com TLS handshake 즉시 fail (<3s TARGET_CONNECT_FAILED)**. 가설: 서버가 MLKEM 우선 선택 → HelloRetryRequest 로 MLKEM key_share 요구 → rustls 가 생성 못 함 (rustls_rustcrypto 에 MLKEM 없음) → handshake abort.
- **결정**: MLKEM supported_groups override revert. JA3 curves field 가 Chrome 148 와 한 항목 차이 (`29-23-24` vs `4588-29-23-24`) 유지하더라도 nid 깨뜨리는 것보다 우선. comment 로 [hs.rs](../../third_party-rustls-fork/src/client/hs.rs) 의 named_groups override 블록 자리에 rationale 영구 기록.
- **재시도 조건**: 실제 MLKEM key_share 생성기 (X25519MLKEM768 hybrid encapsulation) 가 rustls fork 또는 별도 crypto crate (pqcrypto-mlkem)로 들어왔을 때. 그 전엔 wire-level mimicry 의 stretch goal.

**남은 작업** (next session):

1. **ECH GREASE re-enable** with safer payload — `apply_chrome_ja3_shape` 의 5.7 disabled block 을 BoringSSL `ssl_grease_ech_seed` 알고리즘 (per-conn HMAC seed deterministic 도출) 로 re-implement. Spec: `draft-ietf-tls-esni-22` 의 GREASE algorithm. mail.naver.com 회귀 매트릭스 의무.
2. **MLKEM768 key_share** — `rustls_rustcrypto` 가 MLKEM (FIPS 203, X25519MLKEM768 hybrid) 안 함. (a) `pqcrypto-mlkem` crate + manual wire encoding fork, (b) `rustls-post-quantum` (rustls 0.23 post-quantum example) 참조. WASM size 영향 측정 필요. 이게 들어오면 supported_groups 의 4588 도 같이 enable.
3. **h2 SETTINGS 의 `1:65536;2:0;4:6291456;6:262144` 옆 priority 정보 부재**: real Chrome 의 HEADERS frame 에 `Priority (0x20)` flag + `priority(weight=256, depends_on=0, exclusive=1)` payload, ZP 는 미포함. h2 fork 추가 patch 검토.
4. **Diag endpoint `/zp/api/diag/trace` 보호** — 임의 origin 에서 fetch 가능. 운영 전 ZP_CONTROL_TOKEN gate 또는 dev-only flag.

**Lessons 강화**:

1. **"captured spec 설치 == wire 적용" 아님 확인 의무** — fork 가 spec 의 어느 필드를 실제 emit 에 쓰는지 매 변경마다 audit. cipher 만 빠진 케이스가 8개월간 silent 였음.
2. **"wire fix 끝, 다음 phase" 결론 전에 tls.peet.ws byte-by-byte 비교 강제** — Phase 5.1/5.7 두 번 "wire 완성" 선언했지만 실제 wire 는 9-cipher + Go-headers. 매 phase 종료 게이트에 fingerprint diff 표 산출 추가.
3. **"같은 spec 의 captured + override 안 됨"의 silent failure 패턴** — rustls fork 의 `cipher_suites = ...` 는 사실상 wiring 차원의 dead code 였는데 컴파일러는 우리한테 알려주지 않음. 향후 spec 항목별 unit test (golden) 강제: spec 설치 후 wire 출력의 cipher tuple/ext tuple/curve tuple 가 spec 과 정확히 일치하는지 검증.
4. **사용자 challenge 가 design 의 큰 hole 잡아냄** — "정확한 모킹 했어?" 질문 한 줄로 8개월 묻혀있던 cipher dead code 발견. 사용자가 "감 이상하다" 라고 할 때 "끝났다" 는 답 회피 + 즉시 측정 의무.

([client/hs.rs apply_chrome_ja3_shape](../../third_party-rustls-fork/src/client/hs.rs), [tls.rs chrome_ordered_cipher_suites](../../crates/zp-bundle/src/kernel/transport/tls.rs), [sw.js capturedFingerprint](../../web/sw.js), [sw.js HEADER_ORDER](../../web/sw.js), [kernel/mod.rs UA strip removal](../../crates/zp-bundle/src/kernel/mod.rs#L258))

---

## 2026-06-02 — Phase 5.7 ECH GREASE 가 mail.naver.com TLS handshake 깨뜨림 (regression)

**Symptoms**: 사용자 보고 — NAVER 로그인 후 메인 페이지의 "메일" / "페이 바로가기"
link click 시 navigation 안 됨. 진단 결과 `ZeroProxy · Could not reach target`
(`TARGET_CONNECT_FAILED for mail.naver.com`) error 페이지 도착.

**Repro** (taskweaver):
```bash
taskweaver navigate -i zp --url "http://proxy.localhost:18080/zp/"
# launcher 에 https://www.naver.com/ 입력 + Open
# 페이지 로드 후
exec-js: location.href = 'https://mail.naver.com/'
# → TARGET_CONNECT_FAILED
```

**Bisect**:
1. `curl -sv https://mail.naver.com/` (Windows schannel) — **`schannel: remote
   party requests renegotiation`** + 302 redirect 정상.
2. ZeroProxy WASM kernel (rustls + Phase 5.7 ECH GREASE) — connection 실패.
3. ECH GREASE 만 disable (`if false && ...` 게이트) 후 재테스트 — mail.naver.com
   365ms 만에 정상 도착, 받은메일함 (`/v2/folders/0/all`) 표시.

**Root cause**:
Phase 5.7 ECH GREASE 의 payload 구성이 RFC 8701-style 단순 random:
- `cipher_suite = { HKDF_SHA256, AES_128_GCM }`
- `config_id = random u8`
- `enc = 32 random bytes` (X25519 pubkey size)
- `payload = 176 random bytes`

이 형태가 valid `EncryptedClientHelloOuter` 로 decode 가능 → NAVER mail 서버가
**실제 ECH 시도로 해석** + 자신의 ECHConfig 로 decrypt 시도 → 실패 → handshake
abort. RFC 8701 GREASE 처럼 ignore 안 함.

대비: www.naver.com / nid.naver.com / Wikipedia / GitHub 는 ECH GREASE 받아도
정상 (각각 (a) ECH 서버측 미지원이라 ignore, (b) RFC 8701 GREASE 인식, 또는
(c) 다른 정책). mail.naver.com 만 strict.

**Real Chrome 의 ECH GREASE 는 다르다**: BoringSSL 의 `ssl_grease_ech_seed` 가
per-connection HMAC seed 에서 config_id / payload 를 deterministically 도출 →
서버 측에서 "ECH 시도 vs GREASE" 구분 가능. 우리의 단순 random 은 그 신호 없음.

**Fix (commit ?)**:
`third_party-rustls-fork/src/client/hs.rs::apply_chrome_ja3_shape` 의 ECH
GREASE 블록 전체 제거. Padding (RFC 7685, 동일 Phase 5.7) 은 영향 없어 유지.
설계 의도와 향후 re-enable 시 필요 조건 (BoringSSL-compatible 도출) 은 인라인
comment 로 보존.

**Lessons**:
1. **GREASE 는 RFC 8701 정의대로 만든다고 자동으로 안전하지 않다** — 서버 측이
   특정 extension ID 의 GREASE 형태를 spec 별로 가려서 처리. ECH 같은 신생
   extension 은 server 가 RFC ignore 보장 약함. **Test against multiple major
   server stacks before shipping GREASE** for new extension IDs.
2. wire fingerprint mimicry 작업의 **회귀 surface 가 사이트별 다르다** —
   www.naver.com 통과한다고 mail.naver.com 도 통과한다는 보장 없음. NAVER
   같이 큰 사이트 안에서도 sub-domain 별로 TLS 정책 다름.
3. ZeroProxy 의 site-level "Could not reach target" 페이지가 진단에 결정적
   — error code 에 host 명 포함되어 어디서 깨졌는지 즉시 보임.
4. **User report 가 wire 작업 회귀를 잡았다** — phase 1-5.7 작업 후 회귀
   확인을 단순히 "Wikipedia + www.naver.com + GitHub 정상" 으로 close 했는데
   mail.naver.com 같은 sub-domain 미커버. **회귀 매트릭스에 cross-subdomain
   navigation 추가** 필요 — 같은 site 의 sub-host (mail/blog/cafe) click 까지
   포함.

**See also**:
- Phase 5.7 original commit `7bec5bd` (Padding + ECH GREASE 둘 다 add)
- 이 commit (ECH GREASE 만 제거, Padding 유지)
- BoringSSL `ssl_grease_ech_seed` reference 구현
- [hs.rs apply_chrome_ja3_shape](../../third_party-rustls-fork/src/client/hs.rs)

---

## 2026-06-02 — UPDATE: 60s slow-lane 진짜 원인은 IP 도 아니라 session continuity

이전 entry ("IP reputation 가장 유력") 가 부분적으로만 맞음. 사용자가 "탭 분리
안 되어서 문제 아닌가" 질문 후 추가 측정으로 **결정적**으로 IP 가 원인이 아니라
**cookie/referrer chain** 임을 확정.

**측정**:

| 시나리오 | 첫 페인트 시간 |
|---|---|
| ZeroProxy → nid.naver.com **cold** (직접 입력, www 미방문) | 66.5s |
| Real Chrome → nid.naver.com **cold** (incognito 또는 fresh tab, 주소창 입력) | 60.1s |
| ZeroProxy → www.naver.com **cold** | 710ms |
| ZeroProxy → nid.naver.com **warm** (`window.location='nid'` after www 로드) | **393ms** |
| ZeroProxy → pay.naver.com **warm** (after www) → nid 302 redirect | **368ms** |
| ZeroProxy → www.naver.com 메인 페이지의 "페이 바로가기" link click | **527ms** |

**결론**:
NAVER nid 의 60s slow-lane 은 **`Cookie:` 또는 `Referer:` 체인 부재** 에 대한
anti-credential-stuffing 검증. 같은 IP / 같은 brower / 같은 wire fingerprint 라도:
- cookie 없음 + referrer 없음 → 60s 검증
- cookie 있음 (`NACT`, `NID` 같은 추적 쿠키) → 즉시 trust path → ~400ms

ZeroProxy 의 `web/runtime-prelude.js:1659` 가 `document.referrer = ''` 로
강제하지만, HTTP `Referer` header 자체는 SW transportFetch 가 별도 처리.
ZeroProxy cookie jar 가 www.naver.com 방문 시 NACT 등 추적 쿠키를 보존하므로
nid 가 cookie 받음 → trust.

**user 의 "탭 분리" 가설은 부분만 맞음**:
- NAVER 의 "페이 바로가기" link 자체는 `target="_self"` (같은 탭) — `_blank` 아님
- 즉 새 탭 vs 같은 탭 자체는 NAVER 측 의도이고 ZeroProxy 의 single-tab launcher
  와 충돌하지 않음
- **그러나** user 의 실제 사용 패턴은 ZeroProxy launcher 에 nid URL 직접 입력
  인데, 이게 cold session → 60s trip
- 실제 브라우저에서는 사용자가 보통 www.naver.com 부터 시작하기 때문에 자연스럽게
  cookie chain 이 형성되어 nid 가 빠름

**Fix 후보** (PHASE2 plan E1 / D7 의 site-quirk 영역):
1. **NAVER 사이트 quirk**: ZeroProxy launcher 가 nid.naver.com 직접 입력 받으면
   백그라운드에서 먼저 www.naver.com 을 silent GET (cookie 설정) 후 nid 로 navigate.
   사용자 visible 한 1초 정도의 추가 latency 만 발생, 60s 보다 훨씬 나음.
2. **일반화**: site-specific "cookie pre-warm" registry. nid.naver.com 같은 sub
   path 진입 시 parent origin 의 추적 쿠키를 먼저 fetch.
3. **multi-tab launcher** (장기): user 가 자연스럽게 multi-tab flow 가능하면
   real-browser 패턴 그대로 사용 가능. PHASE2 plan 의 D7 storage isolation 과
   호환 가능 (target-origin scoped namespace 안에서 multi-tab cookie 공유).

**Phase 5.7 wire-level 작업의 정당화 (재확인)**:
- wire 강화는 NAVER nid 해결에 직접 기여하지 않았다 (cookie 신호이므로)
- 그러나 tls.peet.ws / browserleaks 같은 fingerprint inspection 사이트 에서 ZeroProxy
  가 Chrome 134 byte-equivalent → 일반 wire-fingerprint WAF 대응 valuable
- 다른 WAF (Cloudflare bot management, Akamai bot manager) 가 wire 강한 의존이면
  phase 1-5.7 가 그 차단을 풀어줌
- 즉 NAVER nid 만 결과적으로 wire 외 신호였다. 다른 도메인에서 wire 강화가 의미
  있을 수 있음.

**Lessons (강화)**:
1. anti-bot debugging 첫 step **"real browser direct 와 비교"** 외 **"same session
   에서 다른 endpoint 방문 후 비교"** 추가 의무화 — cookie/referrer chain
   신호 빠르게 분리 가능. phase 5 deep dive 시작 전 했으면 wire 작업이 NAVER
   목적이 아니라 일반 fingerprint resilience 목적임을 처음부터 명시 가능.
2. cookie chain 신호 는 wire fingerprint 보다 **훨씬** 강한 anti-bot 신호. 거의
   모든 사이트가 cookie 기반 trust path 우선. wire 강화 전 cookie 의 행동 측정
   먼저.
3. ZeroProxy 의 single-tab launcher UX 가 cold session 트립 시 user 가 불편 —
   site-quirk pre-warm 또는 multi-tab UX 가 ROI 크다.

**See also**:
- 아래 이전 entry (이전 IP reputation 결론은 superseded — 측정 부족이 원인)
- [runtime-prelude.js:1659](../../web/runtime-prelude.js#L1659) (document.referrer 마스킹)
- [web/sw.js](../../web/sw.js) cookie jar handlers (ZP_COOKIE_SET / fetchThroughRuntime)
- PHASE2 plan D7 (origin-scoped storage isolation — multi-tab cookie share 와
  관련)

---

## 2026-06-02 — (SUPERSEDED) NAVER nid.naver.com 60s slow-lane 의 진짜 원인은 wire 아닌 IP

**Symptoms**:
- ZeroProxy → `https://nid.naver.com/nidlogin.login` 첫 페인트 **66.5초**
- 같은 ZeroProxy → `https://www.naver.com/` 첫 페인트 **710ms** (정상)
- 같은 ZeroProxy → `https://en.wikipedia.org/...` 첫 페인트 **<1초** (정상)
- 결정타: **real Chrome 134 direct navigation** (ZeroProxy 우회) → `nid.naver.com`
  도 **60.1초**

**Conclusion**:
60-초 slow-lane 은 TLS fingerprint 신호가 아님. wire-level Chrome 134 byte
equivalence (JA3 + JA4 + Akamai-H2 + RFC 8701 GREASE + TLS Padding + ECH GREASE)
를 모두 달성한 뒤에도 동일한 지연이 관찰되고, real Chrome 도 같은 지연을 받음 →
신호 source 는:

1. **IP reputation / geolocation 가장 유력** — NAVER nid 엔드포인트는 SK Broadband
   국내 가정용 IP class 에 대해 endpoint-level 60s rate-limit 또는 graylist 적용.
2. **endpoint-specific WAF rule** — `nid.*` 만 적용되고 `www.naver.com` 은 적용
   안 됨. 즉 NAVER 가 login endpoint 에 별도 anti-credential-stuffing 정책 운영
   가능성.
3. **wire 가 아닌 behavioral correlation** — TLS handshake 완료 후 service
   worker / Akamai bot manager script 가 mouse / timing / CDP 신호를 본 뒤 결정.
   이 경로는 ZeroProxy 가 OXC 리라이트로 멤브레인 안에 들어가기 때문에 영향을
   못 줌.

**검증 절차** (재현 가능):
```bash
# (A) ZeroProxy 경유 vs (B) Chrome direct, 같은 IP 같은 시간
START=$(date +%s%3N); taskweaver navigate -i zp \
  --url "https://nid.naver.com/nidlogin.login" --timeout-ms 60000; \
  END=$(date +%s%3N); echo "DIRECT_NID=$((END-START))ms"
# 결과: DIRECT_NID=60135ms — wire 와 무관
```

**의미**:
NAVER 60-180s slow-lane 추격은 wire-level 에서 종료. 추가 진척은 다음 영역에서만
가능:
- 다른 IP 에서 측정 (proxy / VPN / 다른 ISP). 이건 product 영역 — research 영역
  외.
- NAVER 가 endpoint-level rate limit 을 풀 때까지 대기 (~60s tax 그대로 수용).
- NAVER 가 login endpoint 에 ZeroProxy 의 IP class 화이트리스트 추가 (불가능).

**Phase 5 작업의 정당화**:
NAVER 신호가 wire 가 아니라는 사실은 phase 1-5.7 작업이 헛수고였다는 뜻이 아님.
- tls.peet.ws / browserleaks.com / abrahamjuliot.github.io/creepjs/ 같은
  **TLS fingerprint inspection 사이트** 에서 ZeroProxy 의 fingerprint 가 이제
  Chrome 134 와 byte-equivalent — 별도 wire 신호로 탐지되지 않음.
- 다른 WAF (Cloudflare, Akamai Bot Manager 등) 에서 wire-level 차단을 받았다면
  지금 phase 1-5.7 의 work 가 그 차단을 풀어줌. NAVER nid 만 wire 외 signal.
- Wikipedia / GitHub / 일반 SPA 회귀 정상. 즉 wire 강화의 부작용 없음.

**Lessons**:
1. anti-bot WAF debugging 은 **measurement-first** 원칙 의무화. 추정 (이번엔
   "wire 라서 늦겠지") 만으로 work 시작하면 phase 1-5.7 같은 deep dive 가 헛수고
   가능. 첫 단계는 항상 "같은 사이트에 real browser 로 direct 갔을 때 같은
   지연을 받는가?" 로 wire/non-wire 분리.
2. wire-level fingerprint mimicry 자체는 valuable — TLS inspection 사이트에서
   "browser-like" 신호를 보내고, 다른 WAF 에서 phase-1-5.7 의 결과물이 사용됨.
3. NAVER nid 의 60s slow-lane 은 **product** 영역으로 분리 (서버 IP rotate /
   residential proxy 등). research 영역에서 더 깎을 여지 없음.

**Implementation (Phase 5.7 추가 사항)**:
- `third_party-rustls-fork/src/ja3.rs::PADDING_BODY_LEN = 100` — TLS Padding
  (RFC 7685, id 21) 의 zero-body 길이.
- `third_party-rustls-fork/src/ja3.rs::random_bytes(n)` — xorshift64 기반 ECH
  GREASE 의 enc/payload 채움용. ja3 의 RNG 와 별도 seed (golden ratio).
- `third_party-rustls-fork/src/msgs/macros.rs::encode_one` — id 0x0015 catch-arm
  추가. `ExtensionType::Padding` 이 contiguous_extensions 에 들어오면 zero-body
  100 B 와 함께 wire 출력.
- `third_party-rustls-fork/src/client/hs.rs::apply_chrome_ja3_shape`:
  - Padding 을 contiguous_extensions 맨 끝 (trailing GREASE 직전) 에 삽입
  - ECH GREASE: `exts.encrypted_client_hello = Outer { HKDF_SHA256 + AES_128_GCM,
    random config_id, 32B enc, 176B payload }` — `used_extensions_in_encoding_order`
    가 자동으로 ECH 를 contiguous block 뒤에 append (rustls 0.23 의 강제 위치
    규칙) 하므로 contiguous_extensions 에는 넣지 **않음**. 넣으면 emit 이 중복됨.

**See also**:
- 이전 phase 1-5.6 의 git log (commits `5eff860..064bffc`)
- `cmd/fp-probe/main.go` — TLS ClientHello 캡처 도구
- `internal/fpcapture/` — production 서버 측 capture pipeline
- `web/sw.js::captureBrowserFingerprint` — SW → kernel spec 전달
