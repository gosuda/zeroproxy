//! CSP builder. Single source of truth for the browser side.
//! Go server (`internal/headers/csp.go`) has an independent implementation;
//! parity is enforced via `crates/zp-shared/testdata/csp.golden` (and
//! `csp_challenge.golden` for the armed branch) consumed by both
//! Rust (cargo test) and Go (go test).

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_csp_strict_no_wildcards_no_script_blob() {
        let csp = build_csp("wss://proxy.example");
        assert!(csp.contains("connect-src 'self' wss://proxy.example"));
        assert!(!csp.contains("connect-src *"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob"));
        assert!(!csp.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data"));
        assert!(!csp.contains("style-src *"));
        assert!(!csp.contains("img-src *"));
        assert!(!csp.contains("font-src *"));
        assert!(!csp.contains("media-src *"));
        assert!(csp.contains("default-src 'none'"));
        assert!(csp.contains("object-src 'none'"));
        assert!(csp.contains("frame-ancestors 'none'"));
        assert!(!csp.contains("challenges.cloudflare.com"));
    }

    #[test]
    fn build_csp_matches_golden() {
        let golden = include_str!("../testdata/csp.golden").trim_end();
        let got = build_csp("wss://proxy.example");
        assert_eq!(got, golden, "CSP output drift; regenerate testdata/csp.golden or fix Rust");
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
            &CspOptions { challenge_compat: true },
        );
        // Exactly one occurrence per affected directive: script/frame/child/connect.
        assert_eq!(armed.matches("https://challenges.cloudflare.com").count(), 4);
        assert!(armed.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com"));
        assert!(armed.contains("frame-src 'self' blob: https://challenges.cloudflare.com"));
        assert!(armed.contains("child-src 'self' blob: https://challenges.cloudflare.com"));
        assert!(armed.contains("connect-src 'self' wss://proxy.example https://challenges.cloudflare.com"));
        // Untouched directives must NOT gain the challenge host.
        assert!(!armed.contains("style-src 'self' 'unsafe-inline' https://challenges.cloudflare.com"));
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
            &CspOptions { challenge_compat: true },
        );
        assert_eq!(
            got, golden,
            "armed CSP drift; regenerate testdata/csp_challenge.golden or fix Rust"
        );
    }
}
