# TLS Fingerprint Trap Notebook — 역사적 범주별 요약

ZeroProxy client-TLS(rustls 0.23 + rustls-rustcrypto, WASM linear-memory)의 과거 장애·수정·관측 기록이며 **현재 승인된 사양이 아니다**. 모든 측정은 당시 결과이고 이번 문서 편집에서는 런타임 실행이나 새 검증을 하지 않았다. 과거 제안 테스트·구현 공백은 현재 TODO로 해석하지 않는다. PHASE2 등 상태 문서 및 삭제된 ARCHITECTURE/PHASE 문서는 역사적 참조이지 현재 권위가 아니다.

보안 불변식: **client-TLS가 서버로 누출되어서는 안 되며, fingerprint mimicry도 이 경계를 우회할 수 없다.** 아래 초기의 “wire 완성·IP 원인” 결론은 후속 wire 검사와 session 비교로 정정되었다. NAVER의 서로 다른 지연·렌더 장애를 하나의 원인으로 합치지 않는다. 특히 [7/28 정정](LOG.md#2026-07-28-2)은 END_STREAM/deflate withholding 서사를 yamux lost wakeup으로 철회했다. 아래 7/3 GREASE/binder 결함은 이 전체 지연의 최종 원인 선언이 아니다.

<a id="2026-07-03--naver-tarpit-근본-원인-is_grease_value-비트버그로-extension-grease-가-wire-에-안-나감--version-grease-를-encode-에서-random-호출--resumption-binder-decrypterror"></a>
## 2026-07-03 — NAVER tarpit: GREASE 판정·압축 목록·binder 회귀

- **원인 — extension GREASE 누락:** `ja3.rs::is_grease_value`가 상위 니블까지 `0xA`로 제한하여 16개 GREASE 중 `0xaaaa`만 인정했다. `msgs/macros.rs:227::encode_one` fast-path에서 대부분의 extension GREASE가 drop되었으나, predicate를 거치지 않는 cipher/group GREASE는 남았다. JA4·Akamai hash 일치만으로 이 wire 차이를 발견하지 못했다.
- **수정 — 판정·압축:** 판정식을 `(v & 0x0f0f) == 0x0a0a && (v >> 8) == (v & 0x00ff)`로 교체. rustls가 먼저 설정한 Brotli+Zlib 목록은 `is_none()` 가드 때문에 덮어쓰지 못했으므로 `apply_chrome_ja3_shape`에서 `[Brotli]`를 무조건 지정했다. 내부 offered 목록은 superset이어도 서버의 wire 선택은 Brotli로 제한된다.
- **별도 회귀 — binder:** `SupportedProtocolVersions::encode`에서 매번 `random_grease()`를 호출하자 PSK binder용 직렬화와 실제 wire 직렬화가 달라져 NAVER resumption에 간헐적 `DecryptError`가 발생했다. version GREASE는 `ProtocolVersion::Unknown(0x0a0a)`로 고정했다. **반복 호출 가능한 직렬화 경로에 RNG를 넣지 않는다.** 랜덤 GREASE가 필요하면 handshake당 한 번 생성해 struct에 저장한다.
- **당시 검증:** tls.peet.ws에서 Chrome과 peetprint hash 일치, NAVER 전체 문서 전송·정상 stream close 및 tarpit 소멸을 관측했다. `cologger.shopping.naver.com` trace는 이전 서버측 지연의 근거였다. 같은 IP의 직접 Chrome은 즉시 응답하므로 이 tarpit의 IP/reputation 오진을 철회했다. Wikipedia/GitHub/Cloudflare는 **TLS 성공만** 확인했으며 GitHub·CF/Cloudflare의 모든 문제가 해결됐다는 뜻은 아니다.
- **미해결 별건:** 커널이 문서를 모두 전송·close해도 브라우저 DOM이 간헐적으로 일부만 받은 듯 `interactive`에서 멈췄다. `www.naver.com` 문서의 첫 stream cancel 후 재fetch/close가 trace에 남았다. SW `streamDocumentResponse`/`HtmlTxn` 렌더 경로 가설이며 확정·해결되지 않았다.
- **증거:** `third_party-rustls-fork/src/ja3.rs`, `third_party-rustls-fork/src/msgs/macros.rs`, [client/hs.rs](../../third_party-rustls-fork/src/client/hs.rs). 세부 fingerprinter의 봇 판정 방식은 당시 해석이며, hash 일치가 모든 wire·WAF 동작의 동등성을 보장하지 않는다.

<a id="2026-06-02--phase-58-captured-spec-이-cipher-도-wire-emit-하도록-fork-추가-수정-헤더-순서--ua-정렬-chrome-148-spec-으로-baseline-업데이트-ja3-cipher-tuple-byte-equivalent-chrome-148-8daaf6152771-nidnavercom-target_connect_failed--정상-로드-회복"></a>
## 2026-06-02 — Phase 5.8: captured cipher·헤더·UA 실제 wire 적용

- **원인:** Phase 5.7의 captured spec은 extension 순서에만 적용되고 cipher는 `config.provider.cipher_suites`를 그대로 사용했다. Chrome 134 시기 grouped cipher, SCSV·자동 padding, Firefox 계열 `record_size_limit`, UA/TLS/sec-ch-ua 버전 불일치가 남아 있었다. SW `Headers.entries()`의 정렬로 wire 헤더가 알파벳순이었고, Accept-CH grant 없이 opt-in hints를 전달했으며 kernel이 UA를 끝에 append했다.
- **TLS 수정:** [third_party-rustls-fork/src/client/hs.rs:392-410](../../third_party-rustls-fork/src/client/hs.rs)에서 captured cipher를 wire에 적용하되 provider 목록은 ServerHello 선택 검증용으로 유지했다. captured 사용 시 SCSV를 생략하고 padding은 captured에 있을 때만 추가했다. legacy RSA cipher는 당시 decoy로 광고했으며, 관측한 모던 서버는 구현된 TLS 1.3/ECDHE 계열을 선택했다.
- **baseline 수정:** [web/sw.js:495](../../web/sw.js#L495)의 captured spec을 Chrome 148 cipher·extension 순서로 교체(ECH 제외, captured curves에는 MLKEM 포함). [tls.rs:91-119](../../crates/zp-bundle/src/kernel/transport/tls.rs#L91-L119)의 fallback cipher도 AES128/AES256/CHACHA별 ECDSA→RSA interleaved 순서로 정렬했다. **captured curves에 존재한다는 사실은 실제 지원·wire 적용을 뜻하지 않는다.** 아래 MLKEM revert가 최종 정정이다.
- **HTTP 수정:** [web/sw.js:636-708](../../web/sw.js)에서 grant 없는 device-memory/downlink/dpr/ect/rtt, 상세 sec-ch-ua, viewport/save-data/prefers 계열 hints를 drop하고 Chrome 헤더 순서를 강제했다. UA를 inline 배치하고 [kernel/mod.rs:258](../../crates/zp-bundle/src/kernel/mod.rs#L258)의 `user-agent` strip을 제거했다. [web/zp-core.js:22](../../web/zp-core.js#L22)의 fallback UA를 148로 갱신하되 page native UA가 우선한다.
- **당시 검증·한계:** tls.peet.ws에서 cipher tuple은 Chrome 148과 byte-equivalent였지만 전체 JA3/JA4는 달랐고 ECH·group/key_share 차이가 남았다. `nid.naver.com`은 `TARGET_CONNECT_FAILED`에서 로그인 페이지 로드로 회복했으나 HTTP slow-lane은 잔존했다. “wire 작업 완료, IP만 문제” 결론은 실 wire 검증 없이 내려진 오판이었다. 직접 Chrome의 지연만으로 IP 원인을 확정한 이 항목의 주장도 아래 session 비교가 정정한다.
- **역사적 검증 원칙:** spec 설치와 wire 반영을 구별하고 필드별 emit 경로를 확인해야 한다. byte 비교·golden tests·phase 종료 fingerprint diff는 당시 제안이며 현재 실행 완료로 간주하지 않는다. 관련 위치: [apply_chrome_ja3_shape](../../third_party-rustls-fork/src/client/hs.rs), [chrome_ordered_cipher_suites](../../crates/zp-bundle/src/kernel/transport/tls.rs), [capturedFingerprint](../../web/sw.js), [HEADER_ORDER](../../web/sw.js), [UA strip removal](../../crates/zp-bundle/src/kernel/mod.rs#L258).

**부록 3 — h2 HEADERS PRIORITY 누락**

- **원인:** Akamai hash가 같아도 ZP HEADERS에는 Chrome의 PRIORITY flag와 dependency payload가 없었다. hash가 SETTINGS/WINDOW_UPDATE/pseudo-header 등 일부만 반영하므로 wire 동등성의 증거가 되지 않는다. 특정 WAF의 별도 검사 여부는 당시 해석이다.
- **수정:** [headers.rs](../../third_party-h2-fork/src/frame/headers.rs)에 `Headers::set_priority`와 flag setter 및 HPACK 앞 dependency encoding을 추가했다. [client.rs](../../third_party-h2-fork/src/client.rs)에서 root dependency·exclusive·weight 256(wire byte 255)을 지정하고 [priority.rs](../../third_party-h2-fork/src/frame/priority.rs)에 getter를 추가했다. payload 길이 fix-up에 추가 5바이트가 포함된다.
- **당시 검증:** tls.peet.ws의 HEADERS flag·priority field가 Chrome 148과 일치했고 Wikipedia/mail/nid/GitHub 로드 회귀 검사를 통과했다. 앞서 적힌 “priority patch 검토”는 이 수정으로 대체된 역사적 제안이다.

**부록 2 — GitHub h2 partial body 전체 폐기**

- **원인:** TLS/h2 handshake와 response headers는 성공했지만 declared content-length 전에 stream이 끝나 `h2: body: bytes remaining on stream`이 발생했다. [http2.rs:213-225](../../crates/zp-bundle/src/kernel/transport/http2.rs#L213-L225)의 즉시 error 전파가 이미 받은 body까지 버렸다.
- **당시 수정 규칙:** body가 비어 있으면 fatal error를 유지하고, 받은 bytes가 있으면 partial response로 반환했다. `tx:h2-body-trunc bytes=N err=...` telemetry를 남겼다. 이는 당시 호환성 처리이지 truncated response를 일반적으로 안전하다고 인정하는 현재 사양이 아니다.
- **당시 검증·정정:** GitHub cold load 성공을 관측했다. 이 실패는 trace로 body 처리에 국한했지만, “fingerprint 문제라면 반드시 TLS/h2 handshake도 실패해야 한다”는 일반화는 성립하지 않는다. GitHub·Cloudflare의 다른 미해결 사례까지 해결한 결과로 확대하지 않는다.

**부록 1 — MLKEM supported_groups 광고 후 NAVER 실패, revert**

- **원인:** `exts.named_groups = Some(captured_groups)`로 구현되지 않은 MLKEM을 광고하자 tls.peet.ws는 X25519 fallback으로 통과했지만 `nid.naver.com` TLS가 즉시 실패했다. 서버가 MLKEM HRR을 요구해 key_share 생성 불능으로 중단됐다는 설명은 **가설**이었다.
- **최종 수정·제약:** supported_groups override를 revert하고 [hs.rs](../../third_party-rustls-fork/src/client/hs.rs)에 이유를 기록했다. 따라서 이 시점의 실제 curves는 X25519/P-256/P-384이며, 앞선 “MLKEM emit” 설명보다 이 정정이 우선한다. 구현 없는 group을 단순 fingerprint 일치를 위해 광고하지 않는다.
- **역사적 공백:** 당시 `rustls_rustcrypto`에 X25519MLKEM768 key_share 생성기가 없었다. `pqcrypto-mlkem` 또는 `rustls-post-quantum` 참고·WASM 크기 측정은 제안일 뿐 구현·검증된 상태가 아니다.

**별도 역사적 공백·보안**

- ECH 재활성화는 BoringSSL `ssl_grease_ech_seed`와 `draft-ietf-tls-esni-22`를 참고하고 mail.naver.com 회귀를 확인하자는 당시 제안이었다. 완료된 작업으로 읽지 않는다.
- `/zp/api/diag/trace`가 임의 origin에서 fetch 가능하다는 당시 보안 공백이 기록됐다. **운영 환경에서 진단 endpoint를 무방비로 공개해서는 안 된다.** `ZP_CONTROL_TOKEN` gate 또는 dev-only 제한은 제안 상태이며 여기에는 적용 검증이 없다.
- GitHub·CF/Cloudflare·CNN 미해결 사례를 이 문서의 일부 TLS/로드 성공으로 해결 처리하지 않는다. CNN에 대한 추가 검증 근거는 이 발췌에 없다.

<a id="2026-06-02--phase-57-ech-grease-가-mailnavercom-tls-handshake-깨뜨림-regression"></a>
## 2026-06-02 — Phase 5.7: ECH GREASE로 mail.naver.com 회귀

- **원인·관측:** NAVER 메일 링크가 `TARGET_CONNECT_FAILED`로 끝났다. Schannel 직접 요청은 renegotiation 후 redirect됐고, ZP에서 ECH GREASE만 비활성화하자 받은메일함이 로드됐다. 당시 payload는 HKDF_SHA256/AES_128_GCM, random config_id·enc·payload를 가진 `EncryptedClientHelloOuter`였다.
- **수정:** `third_party-rustls-fork/src/client/hs.rs::apply_chrome_ja3_shape`의 ECH GREASE 블록을 제거하고 padding은 유지했다. 서버가 이를 실제 ECH로 오인·복호화 실패했다거나 BoringSSL의 deterministic seed가 서버에 GREASE 구별 신호를 준다는 설명은 **당시 가설이며 서버측 검증이 없다**. disable bisect 결과와 그 설명을 구분한다.
- **당시 검증·한계:** www/nid/Wikipedia/GitHub 통과가 mail 호환성을 보장하지 않았다. 새 extension 및 cross-subdomain 회귀 검사는 당시 제안이다. 원본 추가 commit `7bec5bd`, ECH 제거 commit은 원문에서 미상(`?`). [hs.rs apply_chrome_ja3_shape](../../third_party-rustls-fork/src/client/hs.rs), BoringSSL `ssl_grease_ech_seed`가 역사적 참고다.

<a id="2026-06-02--update-60s-slow-lane-진짜-원인은-ip-도-아니라-session-continuity"></a>
## 2026-06-02 — UPDATE: nid cold slow-lane과 session continuity

- **후속 관측:** 같은 IP에서 ZP와 직접 Chrome 모두 nid cold navigation은 느렸지만, www 방문 후 nid 또는 pay→nid 이동은 빨랐다. 이는 이전 IP 단독 설명을 뒤집고 cookie/referrer chain을 지지한다. 다만 cookie와 Referer 각각의 인과 및 구체적인 anti-credential-stuffing 정책까지 분리 검증한 것은 아니다.
- **경로·기각:** [runtime-prelude.js:1659](../../web/runtime-prelude.js#L1659)는 `document.referrer`를 비우지만 HTTP Referer는 SW가 별도로 처리하며 cookie jar는 www에서 받은 쿠키를 보존했다. “페이 바로가기”는 `_self`여서 `_blank`/탭 분리 자체가 원인이라는 가설은 기각됐다. launcher에 nid를 직접 입력하는 cold 사용 패턴은 차이를 설명했다.
- **역사적 제안·정정:** parent-origin silent GET/pre-warm registry와 multi-tab cookie 공유는 PHASE2 E1/D7 당시 제안이며 구현 검증이 없다. [web/sw.js](../../web/sw.js)의 `ZP_COOKIE_SET`/`fetchThroughRuntime`가 관련 근거다. 이 session 결과는 **nid cold 지연**에 관한 것이며 7월 GREASE tarpit을 설명하거나 부정하지 않는다. “Phase 5.7 전체 wire가 Chrome과 동등하고 다른 WAF도 해결”이라는 당시 부수 주장은 Phase 5.8/7월 검사로 철회된다.

<a id="2026-06-02--superseded-naver-nidnavercom-60s-slow-lane-의-진짜-원인은-wire-아닌-ip"></a>
## 2026-06-02 — SUPERSEDED: nid slow-lane을 IP로 단정

- **폐기된 결론:** 직접 Chrome도 nid에서 느리고 www/Wikipedia는 빠르다는 관측만으로 IP reputation/geolocation, endpoint graylist 또는 behavioral correlation을 추정했다. ISP/IP class에 특정 정책이 있다는 증거는 없었고, “wire 연구 종료, IP 변경·대기만 가능”이라는 결론도 후속 session/wire 검사로 폐기됐다.
- **당시 구현 기록:** `third_party-rustls-fork/src/ja3.rs::PADDING_BODY_LEN`·`random_bytes(n)` 및 `msgs/macros.rs::encode_one`에 padding/ECH 보조 처리를 추가했다. `apply_chrome_ja3_shape`는 trailing GREASE 직전 padding을 넣었고, ECH는 rustls의 강제 append 경로를 사용했다. **ECH를 contiguous 목록에도 넣으면 중복 emit되므로 금지**했다. ECH 추가는 이후 제거됐고 padding 조건도 Phase 5.8에서 변경됐다.
- **증거·상태:** 과거 commits `5eff860..064bffc`, `cmd/fp-probe/main.go`, `internal/fpcapture/`, `web/sw.js::captureBrowserFingerprint`. 당시 inspection 사이트의 동등성·전체 회귀 정상 주장은 제한된 검사에 근거했으며 후속 발견보다 우선하지 않는다. 비교는 직접 브라우저뿐 아니라 cold/warm session, 실제 wire 필드, TLS→headers→body→렌더 단계별로 구분해야 한다.
