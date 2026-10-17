//! ZeroProxy WASM kernel: JS-facing surface.
//!
//! Lives inside the SW (or a Worker). Exposes `kernelFetch` as the one
//! async entry point that the rest of the JS shell calls; the actual
//! transport plumbing (SOCKS5 + TLS + HTTP/1.1, all client-side) lives in
//! the [`transport`] submodule. The WASM kernel speaks SOCKS5 + TLS + HTTP
//! itself so the relay only sees encrypted bytes.

#![cfg(target_arch = "wasm32")]

pub mod transport;

use js_sys::{Array, ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

/// Bundle version string. Mirrors zp_shared::TRANSFORMER_VERSION so the SW
/// can verify (Rust kernel, Rust rewriter, Rust membrane) all match.
#[wasm_bindgen(js_name = kernelVersion)]
pub fn kernel_version() -> String {
    zp_shared::TRANSFORMER_VERSION.to_string()
}

/// Diagnostic: synchronous probe to verify the basic JsValue ABI works
/// for this crate's wasm-bindgen surface.
#[wasm_bindgen(js_name = kernelEchoSync)]
pub fn kernel_echo_sync(arg: JsValue) -> JsValue {
    push_trace(&format!(
        "echo_sync:is_undef={} is_obj={} as_str={:?}",
        arg.is_undefined(),
        arg.is_object(),
        arg.as_string()
    ));
    arg
}

/// Initialize the Rust kernel.
#[wasm_bindgen(js_name = kernelInit)]
pub fn kernel_init() -> String {
    format!(
        "zp-kernel v{} (rust, ws-tcp + socks5 + tls + http1)",
        zp_shared::TRANSFORMER_VERSION
    )
}

/// Install a captured browser TLS ClientHello so every subsequent upstream
/// handshake replays its shape. Input is the base64-encoded JSON spec served
/// by `/zp/api/fp` (see `internal/fpcapture` for the wire format). On parse
/// failure the kernel falls through to the rustls fork's hardcoded Chrome 134
/// fallback.
///
/// Called once during SW boot from inside `initBundle`. Idempotent in
/// the sense that the rustls thread_local takes last-write-wins
/// semantics; multiple calls within a SW activation simply update.
#[wasm_bindgen(js_name = kernelSetCapturedSpec)]
pub fn kernel_set_captured_spec(b64_json: &str) {
    use base64::Engine;
    // Before anything that can fail: the GREASE draws and the ECH GREASE noise start from real entropy, not from a constant
    // every installation shares (see `rustls::ja3::seed_entropy`).
    let mut seed = [0u8; 8];
    match getrandom::fill(&mut seed) {
        Ok(()) => rustls::ja3::seed_entropy(u64::from_le_bytes(seed)),
        Err(e) => push_trace(&format!("kernel_set_captured_spec:entropy-err={}", e)),
    }
    push_trace(&format!("kernel_set_captured_spec:len={}", b64_json.len()));
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64_json) {
        Ok(b) => b,
        Err(e) => {
            push_trace(&format!("kernel_set_captured_spec:b64-err={}", e));
            return;
        }
    };
    let parsed: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            push_trace(&format!("kernel_set_captured_spec:json-err={}", e));
            return;
        }
    };
    let spec = match captured_spec_from_json(&parsed) {
        Some(s) => s,
        None => {
            push_trace("kernel_set_captured_spec:shape-missing-fields");
            return;
        }
    };
    push_trace(&format!(
        "kernel_set_captured_spec:installed exts={} ciphers={} groups={}",
        spec.extensions.len(),
        spec.cipher_suites.len(),
        spec.named_groups.len()
    ));
    rustls::ja3::set_captured_spec(spec);
}

/// Diagnostic: read the named_groups dump set inside
/// apply_chrome_ja3_shape. Returns "default=...;captured=..." so the SW's
/// `/zp/api/diag/trace` (or any caller) can include it in the
/// diagnostic report.
#[wasm_bindgen(js_name = kernelLastNamedGroups)]
pub fn kernel_last_named_groups() -> String {
    let (def, cap) = rustls::ja3::last_named_groups_dump();
    format!("default={:?};captured={:?}", def, cap)
}

/// Converts the JSON envelope from `/zp/api/fp` into a rustls
/// `CapturedSpec`. We narrow to the typed enums (`CipherSuite`,
/// `NamedGroup`, `ExtensionType`) because rustls's wire codecs operate
/// on those; unknown values get filtered (`From<u16>` falls through
/// to the catch-all variants which rustls treats as no-ops). Returns
/// `None` only if the JSON is missing required arrays; partial or empty
/// arrays still install (with the corresponding emit list being empty).
fn captured_spec_from_json(j: &serde_json::Value) -> Option<rustls::ja3::CapturedSpec> {
    use base64::Engine;
    use rustls::ja3::ExtensionType;
    use rustls::CipherSuite;
    use rustls::NamedGroup;
    let arr_u16 = |key: &str| -> Vec<u16> {
        j.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_u64().map(|n| n as u16))
                    .collect()
            })
            .unwrap_or_default()
    };
    let extensions = arr_u16("extensions")
        .into_iter()
        .map(ExtensionType::from)
        .collect();
    let cipher_suites = arr_u16("cipherSuites")
        .into_iter()
        .map(CipherSuite::from)
        .collect();
    let named_groups = arr_u16("supportedCurves")
        .into_iter()
        .map(NamedGroup::from)
        .collect();
    let versions = arr_u16("supportedVersions");
    let signature_schemes = arr_u16("signatureSchemes");
    let ec_point_formats = j
        .get("supportedPoints")
        .and_then(|v| v.as_str())
        .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok())
        .unwrap_or_default();
    let alpn_protocols = j
        .get("alpnProtocols")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.as_bytes().to_vec()))
                .collect()
        })
        .unwrap_or_default();
    Some(rustls::ja3::CapturedSpec {
        versions,
        cipher_suites,
        extensions,
        named_groups,
        ec_point_formats,
        signature_schemes,
        alpn_protocols,
    })
}

/// Open a relay byte-pipe, run client-side SOCKS5 + TLS + HTTP/1.1 inside
/// this WASM module, and return a `Response` built from the upstream
/// reply.
///
/// Must stay `async`; a sync `fn` returning `Promise` drops the JsValue
/// ABI ref before the deferred async block runs, so by the time the
/// transport layer reads `request_js.url` it's already `undefined`.
#[wasm_bindgen(js_name = kernelFetch)]
pub async fn kernel_fetch(request_js: JsValue) -> Result<JsValue, JsValue> {
    push_trace(&format!(
        "kernel_fetch:entry is_undef={} is_obj={}",
        request_js.is_undefined(),
        request_js.is_object()
    ));
    let url = get_string_prop(&request_js, "url").unwrap_or_default();
    let method = get_string_prop(&request_js, "method").unwrap_or_else(|| "GET".to_string());
    push_trace(&format!(
        "kernel_fetch:captured url={} method={}",
        url, method
    ));

    let mut headers_owned: Vec<(String, String)> = Vec::new();
    // Prefer `headerEntries`, a plain `[[k,v], ...]` array the SW builds
    // manually so it can include Sec-Fetch-*, sec-ch-ua-* and other
    // "forbidden header names" that the Fetch-spec Request constructor
    // would strip. NAVER's WAF (nid.naver.com / pay.naver.com) silently
    // black-holes any request missing these client-hint signals, so the
    // sidechannel is the only way to forward them upstream.
    if let Ok(arr) = Reflect::get(&request_js, &JsValue::from_str("headerEntries")) {
        if !arr.is_undefined() && !arr.is_null() {
            if let Some(arr) = arr.dyn_ref::<Array>() {
                for pair in arr.iter() {
                    if let Some(pair) = pair.dyn_ref::<Array>() {
                        let k = pair.get(0).as_string().unwrap_or_default();
                        let v = pair.get(1).as_string().unwrap_or_default();
                        if !k.is_empty() {
                            headers_owned.push((k, v));
                        }
                    }
                }
            }
        }
    }
    // Fallback: `Request.headers` iteration (loses forbidden headers but
    // works for any caller that didn't migrate to the sidechannel yet).
    if headers_owned.is_empty() {
        if let Ok(h) = Reflect::get(&request_js, &JsValue::from_str("headers")) {
            if !h.is_undefined() && !h.is_null() {
                if let Ok(entries_fn) = Reflect::get(&h, &JsValue::from_str("entries")) {
                    if let Some(f) = entries_fn.dyn_ref::<Function>() {
                        if let Ok(iter) = f.call0(&h) {
                            collect_iter_pairs(&iter, &mut headers_owned);
                        }
                    }
                }
            }
        }
    }
    push_trace(&format!(
        "kernel_fetch:captured headers={}",
        headers_owned.len()
    ));
    // X-ZP-* sidechannel promotion + strip. Anti-CSRF / WAF endpoints reject
    // requests with unknown X-* internal headers or with no real Referer /
    // User-Agent.
    let mut promoted_referer: Option<String> = None;
    let mut promoted_origin: Option<String> = None;
    let mut promoted_ua: Option<String> = None;
    // Capture the per-tab challenge-compat arm BEFORE strip: the marker
    // header itself MUST be stripped (never leaks upstream), but the response
    // builder needs the armed flag to decide whether to emit the response-
    // side `X-ZP-Challenge-Compat: 1` marker when the response classifies as
    // a Cloudflare challenge. Mirrors `internal/headers/ApplyChallengeCompat`.
    let mut armed_challenge_compat = false;
    // The SW's RFC 6265 jar is the sole authority for cookies; the SW strips
    // page-supplied cookie headers and attaches only its jar value (sw.js skips
    // `kl === 'cookie'`). Extract it here and re-append it after promoted
    // headers so Cookie sits at the end of the header list like real Chrome.
    let mut promoted_cookie: Option<String> = None;
    // The SW's order for this request (lowercase names, comma-separated): Chrome's order depends on the kind of
    // request and on the client hints it carries, which only the SW knows.
    let mut sw_order: Option<Vec<String>> = None;
    let mut isolation_key: Option<String> = None;
    headers_owned.retain(|(k, v)| {
        let kl = k.to_ascii_lowercase();
        match kl.as_str() {
            "x-zp-header-order" => {
                sw_order = Some(zp_transport_codec::header_order::parse_header_order(v));
                false
            }
            "x-zp-referer" => {
                promoted_referer = Some(v.clone());
                false
            }
            "x-zp-origin" => {
                promoted_origin = Some(v.clone());
                false
            }
            "x-zp-user-agent" => {
                promoted_ua = Some(v.clone());
                false
            }
            "x-zp-arm-challenge-compat" => {
                if v.trim() == "1" {
                    armed_challenge_compat = true;
                }
                false
            }
            "x-zp-stream-isolation-key" => {
                let val = v.trim();
                if !val.is_empty() {
                    isolation_key = Some(val.to_string());
                }
                false
            }
            // Strip all remaining x-zp-* internal sidechannel headers.
            s if s.starts_with("x-zp-") => false,
            // Strip framing-controlled headers so the transport sets them from
            // canonical sources. `user-agent` is not stripped because the SW
            // emits `ZP.TARGET_USER_AGENT` in its header-order position.
            "cookie" => {
                promoted_cookie = Some(v.clone());
                false
            }
            "host" | "origin" | "referer" | "accept-encoding"
            | "connection" | "content-length" | "transfer-encoding" => false,
            _ => true,
        }
    });
    if let Some(v) = promoted_referer {
        headers_owned.push(("Referer".to_string(), v));
    }
    if let Some(v) = promoted_origin {
        headers_owned.push(("Origin".to_string(), v));
    }
    if let Some(v) = promoted_ua {
        headers_owned.push(("User-Agent".to_string(), v));
    }
    // Keep the advertised codings aligned with the decoder contract: live
    // gzip/deflate use DecompressionStream; br/zstd use bounded Rust decoding.
    headers_owned.push((
        "Accept-Encoding".to_string(),
        "gzip, deflate, br, zstd".to_string(),
    ));
    // Chrome header order places Cookie last.
    if let Some(v) = promoted_cookie {
        headers_owned.push(("Cookie".to_string(), v));
    }
    zp_transport_codec::header_order::order_request_headers(&mut headers_owned, sw_order.as_deref());
    push_trace(&format!(
        "kernel_fetch:hdr-promoted count={}",
        headers_owned.len()
    ));
    if url.contains("nid.naver.com") || url.contains("github.com") {
        let names: Vec<String> = headers_owned
            .iter()
            .map(|(k, v)| format!("{}={}", k, v.chars().take(40).collect::<String>()))
            .collect();
        push_trace(&format!(
            "kernel_fetch:hdr-final url={} hdrs={:?}",
            url, names
        ));
    }

    if url.is_empty() {
        push_trace("kernel_fetch:empty-url");
        return Err(JsValue::from_str("MALFORMED_ROUTE: missing url"));
    }

    // Drain the request body for non-GET/HEAD methods. Without this, every
    // POST/PUT/PATCH/DELETE reaches upstream with an empty body; target
    // endpoints that validate the body (anti-CSRF /api/v1/collect/*, etc)
    // 400 because they expect JSON they never receive.
    let method_upper = method.to_ascii_uppercase();
    let body_bytes: Vec<u8> = if method_upper != "GET" && method_upper != "HEAD" {
        match extract_body_bytes(&request_js).await {
            Ok(b) => b,
            Err(_) => Vec::new(),
        }
    } else {
        Vec::new()
    };
    push_trace(&format!(
        "kernel_fetch:captured body bytes={}",
        body_bytes.len()
    ));

    transport::fetch::fetch(
        &url,
        &method,
        &headers_owned,
        &body_bytes,
        armed_challenge_compat,
        isolation_key.as_deref(),
    )
    .await
}

/// Target-side WebSocket bridge. Opens a yamux + SOCKS5 + optional TLS
/// + RFC 6455 client handshake to `arg.url`, then returns a JS object
/// (`WsClient`) with `protocol`, `bufferedAmount`, `send`, `setHandlers`,
/// `close`, and `abort`. The SW (`web/sw.js` `openRuntimeStream`) drives it. Returns
/// a `Promise<WsClient>`; the resolved value is the same JS class
/// instance regardless of how `Promise` unwraps it.
#[wasm_bindgen(js_name = kernelStream)]
pub fn kernel_stream(arg: JsValue) -> js_sys::Promise {
    wasm_bindgen_futures::future_to_promise(async move {
        // Identity is selected by the SW from the authorized initiating document.
        // Keep it explicit: the target WebSocket origin is not the page origin.
        let url = js_sys::Reflect::get(&arg, &JsValue::from_str("url"))
            .ok()
            .and_then(|v| v.as_string())
            .ok_or_else(|| JsValue::from_str("MALFORMED_ROUTE: kernel_stream missing url"))?;
        let protocols: Vec<String> = js_sys::Reflect::get(&arg, &JsValue::from_str("protocols"))
            .ok()
            .and_then(|v| v.dyn_into::<js_sys::Array>().ok())
            .map(|arr| {
                (0..arr.length())
                    .filter_map(|i| arr.get(i).as_string())
                    .collect()
            })
            .unwrap_or_default();
        let user_agent = get_string_prop(&arg, "userAgent")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| JsValue::from_str("MALFORMED_ROUTE: kernel_stream missing userAgent"))?;
        let origin = get_string_prop(&arg, "origin")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| JsValue::from_str("MALFORMED_ROUTE: kernel_stream missing origin"))?;
        let cookie = get_string_prop(&arg, "cookie").unwrap_or_default();
        let isolation_key = Reflect::get(&arg, &JsValue::from_str("isolationKey"))
            .ok()
            .and_then(|v| v.as_string())
            .filter(|s| !s.is_empty());
        let headers = [("Origin", origin.as_str()), ("User-Agent", user_agent.as_str()), ("Cookie", cookie.as_str())];
        transport::ws_client::open(&url, &protocols, &headers, isolation_key.as_deref()).await
    })
}

/// Cookie jar bridge stub. Real implementation will mirror document.cookie
/// from the SW into a per-tab cookie store before sending each request.
#[wasm_bindgen(js_name = kernelCookieSet)]
pub fn kernel_cookie_set(_payload: &str) -> bool {
    false
}

// JS request decoders (shared by `kernel_fetch` and any future entry points)

pub(crate) fn push_trace(msg: &str) {
    let global = js_sys::global();
    let key = JsValue::from_str("__zpRustTrace");
    let arr = js_sys::Reflect::get(&global, &key).unwrap_or(JsValue::UNDEFINED);
    let arr: js_sys::Array = if arr.is_undefined() {
        let a = js_sys::Array::new();
        let _ = js_sys::Reflect::set(&global, &key, &a);
        a
    } else {
        arr.unchecked_into::<js_sys::Array>()
    };
    if arr.length() >= 512 {
        let _ = arr.shift();
    }
    arr.push(&JsValue::from_str(msg));
}

fn collect_iter_pairs(iter: &JsValue, out: &mut Vec<(String, String)>) {
    let next_fn = match Reflect::get(iter, &JsValue::from_str("next")) {
        Ok(v) => v,
        Err(_) => return,
    };
    let next_fn = match next_fn.dyn_ref::<Function>() {
        Some(f) => f.clone(),
        None => return,
    };
    loop {
        let step = match next_fn.call0(iter) {
            Ok(v) => v,
            Err(_) => return,
        };
        let done = Reflect::get(&step, &JsValue::from_str("done"))
            .ok()
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        if done {
            return;
        }
        let value = match Reflect::get(&step, &JsValue::from_str("value")) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(arr) = value.dyn_ref::<Array>() {
            if arr.length() >= 2 {
                out.push((to_string(&arr.get(0)), to_string(&arr.get(1))));
            }
        }
    }
}

async fn extract_body_bytes(req: &JsValue) -> Result<Vec<u8>, JsValue> {
    let array_buffer_fn = match Reflect::get(req, &JsValue::from_str("arrayBuffer")) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let f = match array_buffer_fn.dyn_ref::<Function>() {
        Some(f) => f.clone(),
        None => return Ok(Vec::new()),
    };
    let promise = match f.call0(req) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    let promise = match promise.dyn_ref::<Promise>() {
        Some(p) => p.clone(),
        None => return Ok(Vec::new()),
    };
    let buf = JsFuture::from(promise).await.unwrap_or(JsValue::UNDEFINED);
    if buf.is_undefined() || buf.is_null() {
        return Ok(Vec::new());
    }
    if let Some(ab) = buf.dyn_ref::<ArrayBuffer>() {
        let arr = Uint8Array::new(ab);
        return Ok(arr.to_vec());
    }
    Ok(Vec::new())
}

fn get_string_prop(obj: &JsValue, key: &str) -> Option<String> {
    let v = Reflect::get(obj, &JsValue::from_str(key)).ok()?;
    if v.is_undefined() || v.is_null() {
        return None;
    }
    if let Some(s) = v.as_string() {
        return Some(s);
    }
    Some(to_string(&v))
}

fn to_string(v: &JsValue) -> String {
    if let Some(s) = v.as_string() {
        return s;
    }
    format!("{:?}", v)
}

