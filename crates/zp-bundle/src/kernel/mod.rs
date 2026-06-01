//! ZeroProxy WASM kernel — JS-facing surface.
//!
//! Lives inside the SW (or a Worker). Exposes `kernelFetch` as the one
//! async entry point that the rest of the JS shell calls; the actual
//! transport plumbing (SOCKS5 + TLS + HTTP/1.1, all client-side) lives in
//! the [`transport`] submodule.
//!
//! ## Step 14: server-TLS regression restoration
//!
//! Step 13 shipped a JSON-envelope relay over `/zp/relay` where the
//! browser sent plaintext `(url, method, headers, body)` to the server
//! and the server did the TLS handshake. That broke the security
//! invariant in ARCHITECTURE.md ("the relay does not parse target HTTP,
//! TLS, redirects, cookies, or HTML"). Step 14 restored it: the WASM
//! kernel speaks SOCKS5 + TLS + HTTP/1.1 itself, and the relay only sees
//! encrypted bytes. See `.ai/trap-notebook/transport-regression.md`.

#![cfg(target_arch = "wasm32")]

pub(crate) mod transport;

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
    push_trace(&format!("echo_sync:is_undef={} is_obj={} as_str={:?}",
        arg.is_undefined(), arg.is_object(), arg.as_string()));
    arg
}

/// Initialize the Rust kernel. Today a no-op — `kernelFetch` opens a
/// fresh WS per request. A persistent yamux session shared across calls
/// is the deferred perf follow-up.
#[wasm_bindgen(js_name = kernelInit)]
pub fn kernel_init() -> String {
    format!("zp-kernel v{} (rust, ws-tcp + socks5 + tls + http1)", zp_shared::TRANSFORMER_VERSION)
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
    push_trace(&format!("kernel_fetch:entry is_undef={} is_obj={}", request_js.is_undefined(), request_js.is_object()));
    let url = get_string_prop(&request_js, "url").unwrap_or_default();
    let method = get_string_prop(&request_js, "method").unwrap_or_else(|| "GET".to_string());
    push_trace(&format!("kernel_fetch:captured url={} method={}", url, method));

    let mut headers_owned: Vec<(String, String)> = Vec::new();
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
    push_trace(&format!("kernel_fetch:captured headers={}", headers_owned.len()));
    // X-ZP-* sidechannel promotion + strip. Mirrors zphttp.BuildHTTP1Request
    // (Go server-side) since the Step-14 client-TLS cutover bypasses that
    // helper entirely — upstream now receives whatever this kernel writes,
    // and anti-CSRF / WAF endpoints reject requests with unknown X-* internal
    // headers or with no real Referer / User-Agent.
    let mut promoted_referer: Option<String> = None;
    let mut promoted_origin: Option<String> = None;
    let mut promoted_ua: Option<String> = None;
    headers_owned.retain(|(k, v)| {
        let kl = k.to_ascii_lowercase();
        match kl.as_str() {
            "x-zp-referer" => { promoted_referer = Some(v.clone()); false }
            "x-zp-origin" => { promoted_origin = Some(v.clone()); false }
            "x-zp-user-agent" => { promoted_ua = Some(v.clone()); false }
            // Strip all remaining x-zp-* internal sidechannel headers.
            s if s.starts_with("x-zp-") => false,
            // Strip browser-controlled or framing-controlled headers — let
            // the transport set them from canonical sources.
            "host" | "cookie" | "origin" | "referer" | "accept-encoding"
            | "connection" | "content-length" | "transfer-encoding" => false,
            _ => true,
        }
    });
    if let Some(v) = promoted_referer { headers_owned.push(("Referer".to_string(), v)); }
    if let Some(v) = promoted_origin { headers_owned.push(("Origin".to_string(), v)); }
    if let Some(v) = promoted_ua { headers_owned.push(("User-Agent".to_string(), v)); }
    headers_owned.push(("Accept-Encoding".to_string(), "identity".to_string()));
    push_trace(&format!("kernel_fetch:hdr-promoted count={}", headers_owned.len()));
    if url.contains("nid.naver.com") || url.contains("github.com") {
        let names: Vec<String> = headers_owned.iter().map(|(k, v)| format!("{}={}", k, v.chars().take(40).collect::<String>())).collect();
        push_trace(&format!("kernel_fetch:hdr-final url={} hdrs={:?}", url, names));
    }

    if url.is_empty() {
        push_trace("kernel_fetch:empty-url");
        return Err(JsValue::from_str("MALFORMED_ROUTE: missing url"));
    }

    // Drain the request body for non-GET/HEAD methods. Without this, every
    // POST/PUT/PATCH/DELETE reaches upstream with an empty body — target
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
    push_trace(&format!("kernel_fetch:captured body bytes={}", body_bytes.len()));

    transport::fetch::fetch(&url, &method, &headers_owned, &body_bytes).await
}

/// Target-side WebSocket bridge. The Step-13 implementation used a
/// `/zp/ws-bridge` server endpoint that terminated TLS server-side —
/// removed in Step 14. The client-side replacement (SOCKS5 + TLS + WS
/// upgrade in the kernel) is a deferred follow-up; until it lands, this
/// stub returns an error so callers fail loudly instead of hanging on a
/// never-resolving Promise.
#[wasm_bindgen(js_name = kernelStream)]
pub fn kernel_stream(_arg: JsValue) -> Result<JsValue, JsValue> {
    Err(JsValue::from_str(
        "TARGET_WS_NOT_REWIRED: client-side WebSocket transport is the Step-14 perf follow-up; \
         only HTTP/HTTPS fetch is wired in this build",
    ))
}

/// Cookie jar bridge stub. Real implementation will mirror document.cookie
/// from the SW into a per-tab cookie store before sending each request.
#[wasm_bindgen(js_name = kernelCookieSet)]
pub fn kernel_cookie_set(_payload: &str) -> bool {
    false
}

// ---------------------------------------------------------------------------
// JS request decoders (shared by `kernel_fetch` and any future entry points)
// ---------------------------------------------------------------------------

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
