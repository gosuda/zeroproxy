//! CSP builders. Single source of truth for **both** CSP surfaces.
//!
//! There are two, and they are deliberately different:
//!
//! 1. **Control surface** ([`build_csp`]). Our own origin: launcher, assets,
//!    error pages (Go `securityHeaders` middleware). No third-party
//!    subresources exist there, so everything locks to `'self'`.
//! 2. **Proxied documents** ([`build_proxied_csp`]). The responses the Service
//!    Worker synthesises for target pages. Also `'self'`-locked, plus
//!    `blob:`/`data:` where target pages legitimately produce them; it differs
//!    from the control surface in `base-uri` and `frame-ancestors` only.
//!
//! Parity is enforced by golden files consumed from every language that emits
//! a policy: Rust (cargo test), Go (`internal/headers/csp_test.go`), and JS
//! (`test/js/static-policy.test.js` evaluates `web/zp-core.js`). There is one
//! copy of each policy string in the repo; drift on any side fails the others.

/// Options for [`build_csp_with`]. `Default` matches the
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
/// `ws_origin` is `wss://<proxy-host>` (or `ws://<proxy-host>` over plain HTTP),
/// the only allowed non-self connect target.
///
/// Strict policy choices:
/// - `default-src 'none'` baseline deny
/// - `script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'`
///   - no `blob:` / `data:` (those scripts are routed through `zp-htmltx`/SW
///     classifier and would only appear unrewritten if the rewriter failed;
///     blocking them here is defense in depth)
///   - `'unsafe-eval'` and `'wasm-unsafe-eval'` required for foreground OXC
///     and the `eval(rewritten)` direct-eval preservation pattern
///   - `'unsafe-inline'` required because rewritten inline scripts still emit
///     inline; CSP cannot distinguish rewritten from raw target inline. The
///     `zp-htmltx` pending gate is the actual enforcement.
/// - All subresource sources lock to `'self'` (proxy origin); blob:/data:
///   allowed only for media/image/frame/worker where target sites legitimately
///   produce them and they cannot leak to network.
/// - `connect-src 'self' <ws_origin>` only: no wildcards, no external origins
/// - `frame-ancestors 'none'`: proxy pages cannot be framed cross-origin
/// - `object-src 'none'`: no plugins
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
    // applied transitively: exactly four directives gain this one origin.
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

/// Build the CSP for **proxied target documents**: the responses the Service
/// Worker synthesises, not our own control surface.
///
/// **Why it differs from [`build_csp`], deliberately:**
/// - `img-src` / `style-src` / `font-src` / `media-src` allow `blob:`/`data:`
///   on top of `'self'` because target pages legitimately produce those and
///   they cannot reach the network. Passive subresource URLs emit
///   `/zp/api/fetch?url=...` from `zp-htmltx` for initial HTML and from the
///   prelude for DOM writes (including `img.src =` property writes), so
///   `'self'` is enforced: a missed rewrite fails loudly and lands in
///   `__zp_refusals()` instead of relying on the SW to catch it.
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
        // `blob:` in script-src: `__ZP_EXEC_INLINE_MODULE` executes rewritten
        // inline module code via `import(blobURL)`. Without it EVERY inline
        // module script dies at CSP. Safe because blob: can only be reached
        // through that path: page `import()` is gated by `__zp_module_url`
        // (non-http throws) and `<script src>` blob: is blocked upstream by
        // the URL-attribute policy, so no unrewritten code can ride it.
        format!(
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:{}",
            cf_suffix
        ),
        "style-src 'self' 'unsafe-inline' blob: data:".to_string(),
        "img-src 'self' blob: data:".to_string(),
        "font-src 'self' blob: data:".to_string(),
        "media-src 'self' blob: data:".to_string(),
        // `blob:`/`data:` in connect-src: both are inert same-origin
        // handles; no network path exists for either. Without them,
        // `fetch('data:...')` and `fetch(blobURL)` (pdf.js / media libs /
        // page-created object URLs) hit CSP before our fetch hook can
        // even see the request.
        format!("connect-src {} blob: data:", connect.join(" ")),
        format!("frame-src 'self' blob: data:{}", cf_suffix),
        format!("child-src 'self' blob: data:{}", cf_suffix),
        "worker-src 'self' blob:".to_string(),
        "object-src 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "form-action 'self'".to_string(),
        "manifest-src 'self'".to_string(),
        // Reporting channel that identifies missed rewrite sites by name.
        // Blocked requests never reach the SW and therefore do not appear in
        // `__zp_refusals()`. Reports include `source-file` and `line-number`
        // alongside `blocked-uri`. Ignored in `<meta>` CSP, but active here
        // because proxied documents also receive the policy as an HTTP header.
        "report-uri /zp/api/csp-report".to_string(),
    ];
    segments.join("; ")
}

/// Intersection filter for `<meta http-equiv="Content-Security-Policy">`.
///
/// Because `<meta>` CSP composes conjunctively with header CSP (a resource must
/// satisfy every active policy), keeping the `<meta>` tag cannot relax our
/// header policy; it can only tighten it. When a target declares a stricter
/// policy, preserving that restriction matches native behavior. The hazard is
/// the reverse: if the target policy blocks our own plumbing (eval/inline
/// execution of rewritten scripts, `/zp/api` transport, worker/frame
/// bootstrapping), the page breaks (for example, a nonce policy blocks the
/// membrane eval path). Each directive is handled by category:
///
/// - **DROP**: Directives that break proxy plumbing or have no meaning in a
///   proxied document: `sandbox` (sandboxes the whole document),
///   `report-uri`/`report-to` (reports directly to target endpoints),
///   `frame-ancestors` (ignored in `<meta>` anyway),
///   `require-trusted-types-for`/`trusted-types` (breaks DOM write paths),
///   `upgrade-insecure-requests`/`block-all-mixed-content` (breaks proxy-origin
///   schemes), `navigate-to`, and any unrecognized directive.
/// - **INFRA directives** (script/connect/worker/child/frame/style families and
///   `default-src`): Union the target sources with our minimum required
///   plumbing sources. Stricter host or scheme restrictions from the `<meta>`
///   tag remain in effect while allowing required proxy plumbing. `'none'` is
///   stripped before taking the union (applying `script-src 'none'` verbatim
///   would disable the membrane itself).
/// - **RESOURCE directives** (img/media/font/object/manifest/prefetch/
///   form-action/base-uri): Preserve `'none'` verbatim when specified (total
///   resource blocking does not affect proxy plumbing); otherwise union with
///   `'self'` because rewritten subresources load from the proxy origin and
///   would otherwise be blocked by target host allowlists.
///
/// Returns an empty string when no directives remain, signaling the caller to
/// neutralize the `<meta>` tag.
pub fn filter_meta_csp(content: &str) -> String {
    filter_meta_csp_with(content, "")
}

/// The CSP source matching every `<label>.localhost` host of a loopback proxy origin (the real origins that serve frames of other
/// sites), or an empty string when the proxy origin is not a loopback name. Keep in sync with `ZP.siteFrameSource`.
pub fn site_frame_source(proxy_origin: &str) -> String {
    let (scheme, rest) = match proxy_origin.split_once("://") {
        Some(parts) => parts,
        None => return String::new(),
    };
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !h.contains(']') => (h, p),
        _ => (authority, ""),
    };
    let host = host.to_ascii_lowercase();
    if host != "localhost" && !host.ends_with(".localhost") {
        return String::new();
    }
    if port.is_empty() {
        format!("{}://*.localhost", scheme)
    } else {
        format!("{}://*.localhost:{}", scheme, port)
    }
}

/// [`filter_meta_csp`] that also admits `site_frame_source` (see [`site_frame_source`]) in `frame-src` and `child-src`, so a target's
/// own `<meta>` policy does not block the real origins that serve its frames. The header policy decides whether a tab may use them.
pub fn filter_meta_csp_with(content: &str, site_frame_source: &str) -> String {
    // Minimum sources required by proxy plumbing for each directive.
    fn infra_sources(name: &str) -> &'static str {
        match name {
            "script-src" | "script-src-elem" | "script-src-attr" =>
                "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
            "connect-src" => "'self' blob: data:",
            "worker-src" => "'self' blob:",
            "child-src" => "'self' blob: data:",
            "frame-src" => "'self' blob: data:",
            "style-src" | "style-src-elem" | "style-src-attr" =>
                "'self' 'unsafe-inline' blob: data:",
            "default-src" =>
                "'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
            _ => "",
        }
    }
    fn is_infra(name: &str) -> bool { !infra_sources(name).is_empty() }
    // Pure resource directives where only tightening applies.
    const RESOURCE: &[&str] = &[
        "img-src", "media-src", "font-src", "object-src", "manifest-src",
        "prefetch-src", "form-action", "base-uri",
    ];
    let mut out: Vec<String> = Vec::new();
    for segment in content.split(';') {
        let seg = segment.trim();
        if seg.is_empty() { continue; }
        let mut it = seg.split_whitespace();
        let name = match it.next() { Some(n) => n.to_ascii_lowercase(), None => continue };
        let mut sources: Vec<String> = it.map(|s| s.to_string()).collect();
        if sources.is_empty() { continue; }
        if is_infra(&name) {
            // `'none'` cannot coexist with other sources; strip it before adding plumbing sources.
            sources.retain(|s| s != "'none'");
            for extra in infra_sources(&name).split_whitespace() {
                if !sources.iter().any(|s| s == extra) { sources.push(extra.to_string()); }
            }
            if !site_frame_source.is_empty() && (name == "frame-src" || name == "child-src") && !sources.iter().any(|s| s == site_frame_source) {
                sources.push(site_frame_source.to_string());
            }
            out.push(format!("{} {}", name, sources.join(" ")));
        } else if RESOURCE.contains(&name.as_str()) {
            if sources.iter().any(|s| s == "'none'") {
                out.push(format!("{} 'none'", name));
            } else {
                if !sources.iter().any(|s| s == "'self'") { sources.push("'self'".to_string()); }
                out.push(format!("{} {}", name, sources.join(" ")));
            }
        }
        // Drop all other directives (DROP list and unknown directives).
    }
    out.join("; ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn site_frame_source_matches_every_label_host_of_a_loopback_proxy() {
        assert_eq!(site_frame_source("http://proxy.localhost:18080"), "http://*.localhost:18080");
        assert_eq!(site_frame_source("https://proxy.localhost"), "https://*.localhost");
        assert_eq!(site_frame_source("http://localhost:8080/x"), "http://*.localhost:8080");
        assert_eq!(site_frame_source("https://proxy.example"), "");
        assert_eq!(site_frame_source("http://evil.localhost.example:80"), "");
        assert_eq!(site_frame_source("not an origin"), "");
    }

    #[test]
    fn filter_meta_csp_admits_the_site_frame_source_in_frames_only() {
        let src = "http://*.localhost:18080";
        let out = filter_meta_csp_with("default-src 'none'; frame-src https://challenges.cloudflare.com; child-src 'none'; script-src 'none'", src);
        assert!(out.contains("frame-src https://challenges.cloudflare.com 'self' blob: data: http://*.localhost:18080"), "{}", out);
        assert!(out.contains("child-src 'self' blob: data: http://*.localhost:18080"), "{}", out);
        assert!(!out.contains("script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: http"), "{}", out);
        assert!(!out.contains("default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: http"), "{}", out);
        // Without a site source the output is the plain filter's, byte for byte.
        let plain = "frame-src https://x.test; img-src https:";
        assert_eq!(filter_meta_csp_with(plain, ""), filter_meta_csp(plain));
    }

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

    /// Shares the same golden file as `ZP.fixedCSP()` in `web/zp-core.js`
    /// (`test/js/static-policy.test.js`), keeping a single policy string in the
    /// repository so drift on either side fails tests.
    #[test]
    fn build_proxied_csp_matches_golden() {
        let golden = include_str!("../testdata/csp_proxied.golden").trim_end();
        assert_eq!(build_proxied_csp("wss://proxy.example"), golden);
    }

    /// Differences between the two surfaces must be deliberate, and the control
    /// surface must remain at least as strict as the proxied surface on passive
    /// resources (e.g., never introducing `*`).
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
                "proxied surface must not wildcard {}; passive URLs are rewritten to /zp/api/fetch now",
                directive
            );
        }
        // Invariants that must hold across both policies.
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
