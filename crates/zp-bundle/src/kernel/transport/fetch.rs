//! Transport-stack entry point used by `kernel_fetch`. Drives the full
//! browser-side path so the relay server only ever sees encrypted bytes.
//!
//! ```text
//! fetch(target_url, method, headers, body)
//!   ├─ parse target_url → host / port / scheme / path
//!   ├─ pool::take((scheme,host,port))        ← reuses warm TLS+HTTP conn
//!   │   │ MISS or stale:
//!   │   └─ yamux::get_or_open(/zp/ws-pipe)    (shared WS, lazy)
//!   │     ├─ session.open_stream()           (new yamux stream)
//!   │     ├─ socks5::connect(host:port)      (relay-side dialer)
//!   │     └─ if https: TlsStream::connect()  (rustls handshake)
//!   ├─ http1::send_request()                 (HTTP/1.1 origin-form)
//!   ├─ pool::put(...) if response_is_keepalive
//!   └─ build_js_response()                   (web_sys::Response with bytes)
//! ```
//!
//! ## Status (Step 14 PoC + keep-alive pool)
//!
//! * No redirect follow — surfaces 3xx to the caller. `kernel_fetch`'s
//!   higher layer is the right place for that so the cookie jar / virtual
//!   URL state stays consistent.
//! * No HTTP/2: ALPN is forced to `http/1.1`. Deferred perf follow-up.
//! * Auth::None: assumes the relay is launched with `-socks internal`.
//!   Tor mode needs `Auth::UserPassword { user: isolation_token, pass: "x" }`
//!   wiring through from the SW; deferred until end-to-end verified.
//! * Response body fully buffered into a Vec<u8> before the JS `Response`
//!   is built — streaming via ReadableStream lands in a follow-up.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;
use web_sys::{Headers, Response, ResponseInit, Url};

use super::http1::{self, HttpResponse};
use super::pool::{self, PoolKey, PooledConn};
use super::socks5::{self, Auth};
use super::tls::TlsStream;
use super::yamux;

/// Top-level entry. The caller (`kernel_fetch`) supplies a fully parsed
/// JS Request as `(url, method, headers, body)`; this function does the
/// rest and returns a JS `Response` for the SW to forward to the page.
///
/// Connection sharing layers:
/// 1. **Pool** — same (scheme,host,port) reuses an already-handshaken
///    `TlsStream` + the live yamux stream beneath it. Zero round-trips
///    on cache hit.
/// 2. **Yamux** — pool miss still skips the WebSocket+TCP handshake by
///    multiplexing onto the singleton session. One yamux SYN per stream.
/// 3. **WebSocket** — the singleton session opens its WS lazily on the
///    very first request and reuses it forever after.
///
/// TLS runs *inside* each yamux stream regardless of pool hit/miss, so
/// the relay never sees plaintext.
pub(crate) async fn fetch(
    target_url: &str,
    method: &str,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<JsValue, JsValue> {
    let parsed = parse_url(target_url).map_err(jserr_str)?;
    let relay_url = pick_relay_url().map_err(jserr_str)?;
    let key = PoolKey {
        scheme: parsed.scheme.clone(),
        host: parsed.host.clone(),
        port: parsed.port,
    };
    let host_h = host_header(&parsed);
    crate::kernel::push_trace(&format!(
        "transport:start host={} port={} scheme={}",
        parsed.host, parsed.port, parsed.scheme
    ));

    // Fast path: warm conn from the per-origin pool. On stale (write or
    // read fails on the cached conn), fall through to the fresh path.
    // We don't retry on the same key — the next call will re-fill the pool.
    if let Some(mut conn) = pool::take(&key) {
        crate::kernel::push_trace(&format!("transport:pool-hit host={}", parsed.host));
        match http1::send_request(&mut conn, method, &host_h, &parsed.path, headers, body).await {
            Ok(resp) => {
                crate::kernel::push_trace(&format!(
                    "transport:pool-reuse-ok host={} status={}",
                    parsed.host, resp.status
                ));
                if http1::response_is_keepalive(&resp) {
                    pool::put(key, conn);
                }
                return build_js_response(resp, target_url);
            }
            Err(e) => {
                crate::kernel::push_trace(&format!(
                    "transport:pool-stale host={} err={} (reopening)",
                    parsed.host, e
                ));
                // Drop `conn`; the yamux stream FINs and the pool entry
                // for this key is now empty until we put a fresh one.
            }
        }
    }

    // Cold path: open a fresh conn (yamux + SOCKS5 + TLS).
    let mut conn = open_fresh(&parsed, &relay_url).await?;
    let resp = http1::send_request(&mut conn, method, &host_h, &parsed.path, headers, body)
        .await
        .map_err(|e| {
            crate::kernel::push_trace(&format!(
                "transport:http-err host={} err={}",
                parsed.host, e
            ));
            jserr("TARGET_HTTP_FAILED", &e)
        })?;
    crate::kernel::push_trace(&format!(
        "transport:http-ok host={} status={}",
        parsed.host, resp.status
    ));
    if http1::response_is_keepalive(&resp) {
        pool::put(key, conn);
    }
    build_js_response(resp, target_url)
}

/// Build a fresh `PooledConn` from scratch: yamux stream → SOCKS5 →
/// (TLS if https). Retries once if the yamux session itself looks stale.
async fn open_fresh(parsed: &ParsedUrl, relay_url: &str) -> Result<PooledConn, JsValue> {
    let session = yamux::get_or_open(relay_url).await.map_err(|e| {
        crate::kernel::push_trace(&format!("transport:mux-session-err err={}", e));
        jserr("TARGET_CONNECT_FAILED:mux-session", &e)
    })?;
    let mut stream = match session.open_stream().await {
        Ok(s) => s,
        Err(e) => {
            crate::kernel::push_trace(&format!(
                "transport:mux-open-err host={} err={} (reopening)",
                parsed.host, e
            ));
            // Pool entries reference yamux streams whose parent session
            // is now gone — clear them too so we don't keep handing out
            // dead conns.
            yamux::invalidate();
            pool::clear();
            let session = yamux::get_or_open(relay_url)
                .await
                .map_err(|e| jserr("TARGET_CONNECT_FAILED:mux-reopen", &e))?;
            session.open_stream().await.map_err(|e| {
                crate::kernel::push_trace(&format!(
                    "transport:mux-open-err2 host={} err={}",
                    parsed.host, e
                ));
                jserr("TARGET_CONNECT_FAILED:mux-open", &e)
            })?
        }
    };
    crate::kernel::push_trace(&format!("transport:mux-stream-ok host={}", parsed.host));

    socks5::connect(&mut stream, &parsed.host, parsed.port, &Auth::None)
        .await
        .map_err(|e| {
            crate::kernel::push_trace(&format!(
                "transport:socks5-err host={} err={}",
                parsed.host, e
            ));
            jserr("TARGET_CONNECT_FAILED:socks5", &e)
        })?;
    crate::kernel::push_trace(&format!("transport:socks5-ok host={}", parsed.host));

    if parsed.scheme == "https" {
        let tls = TlsStream::connect(stream, &parsed.host, &[b"http/1.1"])
            .await
            .map_err(|e| {
                crate::kernel::push_trace(&format!(
                    "transport:tls-err host={} err={}",
                    parsed.host, e
                ));
                jserr("TARGET_TLS_FAILED", &e)
            })?;
        crate::kernel::push_trace(&format!("transport:tls-ok host={}", parsed.host));
        Ok(PooledConn::Tls(Box::new(tls)))
    } else {
        Ok(PooledConn::Plain(stream))
    }
}

struct ParsedUrl {
    scheme: String,
    host: String,
    port: u16,
    path: String,
}

/// Parse `http[s]://host[:port]/path[?query]` via the browser's `URL`
/// constructor. WHATWG semantics handle punycode / percent-encoding /
/// default ports correctly — much safer than rolling our own.
fn parse_url(url: &str) -> Result<ParsedUrl, String> {
    let u = Url::new(url).map_err(|_| format!("bad URL: {url}"))?;
    let proto = u.protocol(); // e.g. "https:"
    let scheme = proto.trim_end_matches(':').to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("unsupported scheme: {scheme}"));
    }
    let host = u.hostname();
    if host.is_empty() {
        return Err(format!("empty host in URL: {url}"));
    }
    let port_str = u.port();
    let port: u16 = if port_str.is_empty() {
        if scheme == "https" {
            443
        } else {
            80
        }
    } else {
        port_str.parse().map_err(|_| format!("bad port: {port_str}"))?
    };
    let mut path = u.pathname();
    let search = u.search();
    if !search.is_empty() {
        path.push_str(&search);
    }
    if path.is_empty() {
        path = "/".to_string();
    }
    Ok(ParsedUrl {
        scheme,
        host,
        port,
        path,
    })
}

/// `Host:` header content. Default-port pairings get host only; non-default
/// ports get `host:port` (per RFC 7230 §5.4).
fn host_header(u: &ParsedUrl) -> String {
    let default = matches!(
        (u.scheme.as_str(), u.port),
        ("http", 80) | ("https", 443)
    );
    if default {
        u.host.clone()
    } else {
        format!("{}:{}", u.host, u.port)
    }
}

/// Build the relay WebSocket URL from `self.location`. Targets the
/// `/zp/ws-pipe` yamux endpoint — the server runs `yamuxconn.Server()`
/// on the WebSocket and bridges each yamux stream through
/// `bridgeTargetStream` (SOCKS5 → upstream). Step-14's intermediate
/// `/zp/ws-tcp` (1 WS = 1 stream) was removed once yamux landed.
fn pick_relay_url() -> Result<String, String> {
    let global = js_sys::global();
    let location = js_sys::Reflect::get(&global, &JsValue::from_str("location"))
        .map_err(|_| "SW_NOT_READY: no location".to_string())?;
    let host = js_sys::Reflect::get(&location, &JsValue::from_str("host"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_default();
    let protocol = js_sys::Reflect::get(&location, &JsValue::from_str("protocol"))
        .ok()
        .and_then(|v| v.as_string())
        .unwrap_or_else(|| "http:".to_string());
    if host.is_empty() {
        return Err("SW_NOT_READY: empty host".to_string());
    }
    let scheme = if protocol == "https:" { "wss" } else { "ws" };
    Ok(format!("{}://{}/zp/ws-pipe", scheme, host))
}

/// Convert the buffered HTTP response into a web_sys::Response. Headers
/// are appended (not set) so multi-valued headers like `Set-Cookie` and
/// repeated `Link` survive.
fn build_js_response(resp: HttpResponse, _final_url: &str) -> Result<JsValue, JsValue> {
    let headers = Headers::new()?;
    for (k, v) in &resp.headers {
        // Headers.append rejects a few wire-level header names by spec
        // (e.g. forbidden response headers). Ignore failures so a single
        // hostile header doesn't abort the whole response.
        let _ = headers.append(k, v);
    }
    let body_array = Uint8Array::new_with_length(resp.body.len() as u32);
    body_array.copy_from(&resp.body);

    let init = ResponseInit::new();
    init.set_status(resp.status);
    init.set_status_text(&resp.reason);
    init.set_headers(&headers);

    let response = Response::new_with_opt_buffer_source_and_init(
        Some(&body_array.buffer()),
        &init,
    )?;
    Ok(response.into())
}

fn jserr_str(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{e}"))
}

fn jserr(prefix: &str, e: &impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&format!("{prefix}: {e}"))
}
