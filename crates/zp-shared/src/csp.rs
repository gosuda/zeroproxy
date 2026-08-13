//! CSP builders. Single source of truth for **both** CSP surfaces.
//!
//! There are two, and they are deliberately different:
//!
//! 1. **Control surface** — [`build_csp`]. Our own origin: launcher, assets,
//!    error pages (Go `securityHeaders` middleware). No third-party
//!    subresources exist there, so everything locks to `'self'`.
//! 2. **Proxied documents** — [`build_proxied_csp`]. The responses the Service
//!    Worker synthesises for target pages. Also `'self'`-locked, plus
//!    `blob:`/`data:` where target pages legitimately produce them; it differs
//!    from the control surface in `base-uri` and `frame-ancestors` only.
//!
//! Parity is enforced by golden files consumed from every language that emits
//! a policy — Rust (cargo test), Go (`internal/headers/csp_test.go`), and JS
//! (`test/js/static-policy.test.js` evaluates `web/zp-core.js`). There is one
//! copy of each policy string in the repo; drift on any side fails the others.
//!
//! 2026-08-13: the proxied policy previously lived only in `web/zp-core.js`
//! with nothing tying it to anything. Go and Rust stayed in step via golden
//! while the policy that actually governs every proxied page drifted unseen.

/// Options for [`build_csp_with`]. `Default` matches the historical
/// `build_csp(ws_origin)` output byte-for-byte (golden-stable).
#[derive(Debug, Clone, Copy, Default)]
pub struct CspOptions {
    /// When true, project the armed Cloudflare-Turnstile compatibility branch:
    /// add `https://challenges.cloudflare.com` to `script-src`, `frame-src`,
    /// `child-src`, `connect-src`. Adds NO wildcard, NO direct-egress capability
    /// (challenge subresources still route through the proxy), NO new eval. The
    /// caller is responsible for the per-tab two-signal gate (operator opt-in
    /// AND classifier match); this builder is a pure projection.
    pub challenge_compat: bool,
}

/// Build the strict CSP header value for ZeroProxy responses.
///
/// `ws_origin` is `wss://<proxy-host>` (or `ws://<proxy-host>` over plain HTTP)
/// — the only allowed non-self connect target.
///
/// Strict policy choices:
/// - `default-src 'none'` baseline deny
/// - `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`
///   - no `blob:` / `data:` (those scripts are routed through `zp-htmltx`/SW
///     classifier and would only appear unrewritten if the rewriter failed —
///     blocking them here is defense in depth)
///   - `'unsafe-eval'` and `'wasm-unsafe-eval'` required for foreground OXC
///     and the `eval(rewritten)` direct-eval preservation pattern
///   - `'unsafe-inline'` required because rewritten inline scripts still emit
///     inline; CSP cannot distinguish rewritten from raw target inline. The
///     `zp-htmltx` pending gate is the actual enforcement.
/// - All subresource sources lock to `'self'` (proxy origin); blob:/data:
///   allowed only for media/image/frame/worker where target sites legitimately
///   produce them and they cannot leak to network.
/// - `connect-src 'self' <ws_origin>` only — no wildcards, no external origins
/// - `frame-ancestors 'none'` — proxy pages cannot be framed cross-origin
/// - `object-src 'none'` — no plugins
///
/// Stable output; changing this requires regenerating `testdata/csp.golden`.
pub fn build_csp(ws_origin: &str) -> String {
    build_csp_with(ws_origin, &CspOptions::default())
}

/// Build the CSP header value with explicit policy options. With
/// `CspOptions::default()` the output is byte-identical to [`build_csp`].
pub fn build_csp_with(ws_origin: &str, opts: &CspOptions) -> String {
    let ws = ws_origin.trim();
    // Cloudflare-Turnstile challenge host. Added to script/frame/child/connect
    // only when the caller has armed challenge_compat. Never wildcarded, never
    // applied transitively — exactly four directives gain this one origin.
    const CF: &str = "https://challenges.cloudflare.com";
    let cf_suffix = if opts.challenge_compat {
        format!(" {}", CF)
    } else {
        String::new()
    };
    let segments: Vec<String> = vec![
        "default-src 'none'".to_string(),
        format!(
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'{}",
            cf_suffix
        ),
        "style-src 'self' 'unsafe-inline'".to_string(),
        "img-src 'self' blob: data:".to_string(),
        "font-src 'self' data:".to_string(),
        "media-src 'self' blob:".to_string(),
        format!("connect-src 'self' {}{}", ws, cf_suffix),
        format!("frame-src 'self' blob:{}", cf_suffix),
        format!("child-src 'self' blob:{}", cf_suffix),
        "worker-src 'self' blob:".to_string(),
        "manifest-src 'self'".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'self'".to_string(),
        "form-action 'self'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ];
    segments.join("; ")
}

/// Build the CSP for **proxied target documents** — the responses the Service
/// Worker synthesises, not our own control surface.
///
/// 2026-08-13: this policy used to live only in `web/zp-core.js` (`ZP.fixedCSP`)
/// with nothing tying it to anything. Go was golden-locked to [`build_csp`],
/// so the two policies that *were* checked stayed in step while the one that
/// actually governs every proxied page drifted unnoticed. Both now live here.
///
/// **Why it differs from [`build_csp`], deliberately:**
/// - `img-src` / `style-src` / `font-src` / `media-src` allow `blob:`/`data:`
///   on top of `'self'` because target pages legitimately produce those and
///   they cannot reach the network. These were `*` until 2026-08-13: passive
///   subresource URLs written at runtime stayed as the raw target URL, so
///   `'self'` would have blocked every image before the SW could intercept.
///   Both halves emit `/zp/api/fetch?url=…` now — `zp-htmltx` for the initial
///   HTML, and the prelude for DOM writes (including `img.src =` **property**
///   writes, which bypassed the `setAttribute` hook entirely and were the last
///   source of raw URLs). So `'self'` is a real wall again: a missed rewrite
///   fails loudly and lands in `__zp_refusals()` instead of quietly relying on
///   the SW to catch it.
/// - `base-uri 'none'` is *stricter* than the control surface: target pages
///   must not be able to repoint relative URL resolution.
/// - `frame-ancestors` is absent on purpose: proxied documents are loaded into
///   our own nested iframes, which `'none'` would forbid.
///
/// `extra_connect` carries the relay server origins the JS builder derives from
/// the share fragment. Order matters for golden stability: `'self'`, the ws
/// origin, then extras in argument order, de-duplicated.
pub fn build_proxied_csp(ws_origin: &str) -> String {
    build_proxied_csp_with(ws_origin, &[], &CspOptions::default())
}

/// [`build_proxied_csp`] with relay origins and explicit options.
pub fn build_proxied_csp_with(ws_origin: &str, extra_connect: &[&str], opts: &CspOptions) -> String {
    const CF: &str = "https://challenges.cloudflare.com";
    let cf_suffix = if opts.challenge_compat {
        format!(" {}", CF)
    } else {
        String::new()
    };
    let mut connect: Vec<String> = vec!["'self'".to_string(), ws_origin.trim().to_string()];
    for origin in extra_connect {
        let o = origin.trim().to_string();
        if !o.is_empty() && !connect.contains(&o) {
            connect.push(o);
        }
    }
    if opts.challenge_compat && !connect.iter().any(|c| c == CF) {
        connect.push(CF.to_string());
    }
    let segments: Vec<String> = vec![
        "default-src 'none'".to_string(),
        format!(
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'{}",
            cf_suffix
        ),
        "style-src 'self' 'unsafe-inline' blob: data:".to_string(),
        "img-src 'self' blob: data:".to_string(),
        "font-src 'self' blob: data:".to_string(),
        "media-src 'self' blob: data:".to_string(),
        format!("connect-src {}", connect.join(" ")),
        format!("frame-src 'self' blob: data:{}", cf_suffix),
        format!("child-src 'self' blob: data:{}", cf_suffix),
        "worker-src 'self' blob:".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "form-action 'self'".to_string(),
        "manifest-src 'self'".to_string(),
    ];
    segments.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_csp_strict_no_wildcards_no_script_blob() {
        let csp = build_csp("wss://proxy.example");
        assert!(csp.contains("connect-src 'self' wss://proxy.example"));
        assert!(!csp.contains("connect-src *"));
        assert!(!csp
            .contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob"));
        assert!(!csp
            .contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data"));
        assert!(!csp.contains("style-src *"));
        assert!(!csp.contains("img-src *"));
        assert!(!csp.contains("font-src *"));
        assert!(!csp.contains("media-src *"));
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("challenges.cloudflare.com"));
    }

    /// 이 골든은 `web/zp-core.js` 의 `ZP.fixedCSP()` 와 **같은 파일**을 본다
    /// (`test/js/static-policy.test.js`). 저장소 안에 정책 문자열은 하나뿐이고,
    /// 어느 쪽이 흘러도 반대편 테스트가 깨진다.
    #[test]
    fn build_proxied_csp_matches_golden() {
        let golden = include_str!("../testdata/csp_proxied.golden").trim_end();
        assert_eq!(build_proxied_csp("wss://proxy.example"), golden);
    }

    /// 두 표면의 차이는 **의도된 것만** 있어야 한다. 통제 표면이 수동 리소스에
    /// 대해 더 엄격하다는 관계가 깨지면(예: 통제 표면에 `*` 가 들어오면)
    /// 여기서 잡는다.
    #[test]
    fn control_surface_stays_stricter_on_passive_sources() {
        let control = build_csp("wss://proxy.example");
        let proxied = build_proxied_csp("wss://proxy.example");
        for directive in ["style-src", "img-src", "font-src", "media-src"] {
            assert!(
                !control.contains(&format!("{} *", directive)),
                "control surface must never wildcard {}",
                directive
            );
            assert!(
                !proxied.contains(&format!("{} *", directive)),
                "proxied surface must not wildcard {} — passive URLs are rewritten to /zp/api/fetch now",
                directive
            );
        }
        // 두 정책 모두에서 절대 흔들리면 안 되는 것들.
        for invariant in ["default-src 'none'", "object-src 'none'", "form-action 'self'"] {
            assert!(control.contains(invariant), "control lost {}", invariant);
            assert!(proxied.contains(invariant), "proxied lost {}", invariant);
        }
        assert!(!proxied.contains("connect-src *"), "connect-src must never wildcard");
        assert!(!proxied.contains("script-src *"), "script-src must never wildcard");
    }

    #[test]
    fn build_csp_matches_golden() {
        let golden = include_str!("../testdata/csp.golden").trim_end();
        let got = build_csp("wss://proxy.example");
        assert_eq!(
            got, golden,
            "CSP output drift; regenerate testdata/csp.golden or fix Rust"
        );
    }

    #[test]
    fn build_csp_default_options_match_legacy_signature() {
        // Pin: opts-default and the legacy ws-only signature must agree byte-for-byte.
        let legacy = build_csp("wss://proxy.example");
        let opts = build_csp_with("wss://proxy.example", &CspOptions::default());
        assert_eq!(legacy, opts);
    }

    #[test]
    fn build_csp_armed_adds_cloudflare_to_exactly_four_directives() {
        let armed = build_csp_with(
            "wss://proxy.example",
            &CspOptions {
                challenge_compat: true,
            },
        );
        // Exactly one occurrence per affected directive: script/frame/child/connect.
        assert_eq!(
            armed.matches("https://challenges.cloudflare.com").count(),
            4
        );
        assert!(armed.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com"));
        assert!(armed.contains("frame-src 'self' blob: https://challenges.cloudflare.com"));
        assert!(armed.contains("child-src 'self' blob: https://challenges.cloudflare.com"));
        assert!(armed
            .contains("connect-src 'self' wss://proxy.example https://challenges.cloudflare.com"));
        // Untouched directives must NOT gain the challenge host.
        assert!(
            !armed.contains("style-src 'self' 'unsafe-inline' https://challenges.cloudflare.com")
        );
        assert!(!armed.contains("img-src 'self' blob: data: https://challenges.cloudflare.com"));
        assert!(!armed.contains("worker-src 'self' blob: https://challenges.cloudflare.com"));
        // No wildcards, no new eval, no nonce inflation.
        assert!(!armed.contains(" *"));
        assert!(!armed.contains("'nonce-"));
        // Baseline invariants survive the projection.
        assert!(armed.starts_with("default-src 'none'"));
        assert!(armed.contains("object-src 'none'"));
        assert!(armed.contains("frame-ancestors 'none'"));
    }

    #[test]
    fn build_csp_armed_matches_golden() {
        let golden = include_str!("../testdata/csp_challenge.golden").trim_end();
        let got = build_csp_with(
            "wss://proxy.example",
            &CspOptions {
                challenge_compat: true,
            },
        );
        assert_eq!(
            got, golden,
            "armed CSP drift; regenerate testdata/csp_challenge.golden or fix Rust"
        );
    }
}
