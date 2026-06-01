//! SOCKS5 client (RFC 1928 + RFC 1929) over any `AsyncRead + AsyncWrite`.
//!
//! ## Scope
//!
//! Just enough SOCKS5 to talk to the relay's `-socks internal` parser and
//! to a real Tor SOCKS5 listener:
//!
//! * Greeting with `NoAuth` (0x00) and/or `UsernamePassword` (0x02).
//! * RFC 1929 username/password sub-negotiation. Used by Tor for
//!   `IsolateSOCKSAuth` — the username:password pair is the isolation key,
//!   not a real credential, so any string under 255 bytes is accepted.
//! * `CONNECT` (0x01) with `DOMAINNAME` (0x03) ATYP. ZeroProxy intentionally
//!   never sends IPv4/IPv6 ATYP — every target is identified by hostname so
//!   the relay/Tor side does the DNS resolution and we don't leak browser-side
//!   resolver behaviour. `IPV4`/`IPV6` parsing in the *reply* is supported.
//!
//! No `BIND`, no `UDP ASSOCIATE`, no GSSAPI. The stream returned by
//! [`connect`] is the *same* stream passed in; SOCKS5 only does an in-band
//! handshake and then steps out of the way.

use std::io;

use futures_util::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const VER: u8 = 0x05;
const METHOD_NO_AUTH: u8 = 0x00;
const METHOD_USER_PASS: u8 = 0x02;
const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;

const CMD_CONNECT: u8 = 0x01;
const RSV: u8 = 0x00;

const ATYP_IPV4: u8 = 0x01;
const ATYP_DOMAIN: u8 = 0x03;
const ATYP_IPV6: u8 = 0x04;

const SUBNEG_VER: u8 = 0x01;
const SUBNEG_STATUS_OK: u8 = 0x00;

/// SOCKS5 authentication mode.
#[derive(Clone, Debug)]
pub enum Auth {
    /// Send `NoAuth` only. Used by the relay's `-socks internal` mode.
    None,
    /// Send `NoAuth` + `UsernamePassword`. The server picks. Used by Tor:
    /// the username/password pair is the IsolateSOCKSAuth circuit key.
    /// Both strings must be 1..=255 bytes.
    UserPassword { user: String, pass: String },
}

/// Perform a SOCKS5 CONNECT handshake on `stream`, asking the relay to
/// dial `host:port`. Returns the same stream once the handshake succeeds;
/// from that point the stream is a transparent byte pipe to `host:port`
/// and the caller can run TLS or HTTP directly on top.
///
/// `host` is sent verbatim as ATYP=DOMAINNAME — no resolver is run on the
/// browser side. `host.len()` must fit in a single byte (≤255), which all
/// real DNS names do.
pub async fn connect<S>(stream: &mut S, host: &str, port: u16, auth: &Auth) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if host.is_empty() || host.len() > 255 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socks5: hostname must be 1..=255 bytes",
        ));
    }

    method_negotiation(stream, auth).await?;
    request_connect(stream, host, port).await?;
    Ok(())
}

/// Phase 1: greeting + method selection (+ optional username/password
/// sub-negotiation).
async fn method_negotiation<S>(stream: &mut S, auth: &Auth) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let methods: &[u8] = match auth {
        Auth::None => &[METHOD_NO_AUTH],
        Auth::UserPassword { .. } => &[METHOD_NO_AUTH, METHOD_USER_PASS],
    };
    let mut greeting = Vec::with_capacity(2 + methods.len());
    greeting.push(VER);
    greeting.push(methods.len() as u8);
    greeting.extend_from_slice(methods);
    stream.write_all(&greeting).await?;
    stream.flush().await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    if reply[0] != VER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: bad greeting reply VER=0x{:02x}", reply[0]),
        ));
    }
    match reply[1] {
        METHOD_NO_AUTH => Ok(()),
        METHOD_USER_PASS => match auth {
            Auth::UserPassword { user, pass } => userpass_subneg(stream, user, pass).await,
            Auth::None => Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "socks5: server selected USER_PASS but Auth::None was requested",
            )),
        },
        METHOD_NONE_ACCEPTABLE => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "socks5: server has no acceptable auth method",
        )),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: server selected unsupported method 0x{other:02x}"),
        )),
    }
}

/// RFC 1929 username/password sub-negotiation. Lengths bounded to 255 by
/// the protocol.
async fn userpass_subneg<S>(stream: &mut S, user: &str, pass: &str) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    if user.is_empty() || user.len() > 255 || pass.is_empty() || pass.len() > 255 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socks5: user/pass must each be 1..=255 bytes",
        ));
    }
    let mut buf = Vec::with_capacity(3 + user.len() + pass.len());
    buf.push(SUBNEG_VER);
    buf.push(user.len() as u8);
    buf.extend_from_slice(user.as_bytes());
    buf.push(pass.len() as u8);
    buf.extend_from_slice(pass.as_bytes());
    stream.write_all(&buf).await?;
    stream.flush().await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    if reply[0] != SUBNEG_VER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: bad subneg reply VER=0x{:02x}", reply[0]),
        ));
    }
    if reply[1] != SUBNEG_STATUS_OK {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("socks5: userpass auth rejected (status=0x{:02x})", reply[1]),
        ));
    }
    Ok(())
}

/// Phase 2: CONNECT request + reply parsing. On success the stream is now
/// a transparent byte pipe to `host:port`.
async fn request_connect<S>(stream: &mut S, host: &str, port: u16) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    // Build: VER CMD RSV ATYP=DOMAIN LEN HOST PORT(be u16)
    let mut req = Vec::with_capacity(7 + host.len());
    req.push(VER);
    req.push(CMD_CONNECT);
    req.push(RSV);
    req.push(ATYP_DOMAIN);
    req.push(host.len() as u8);
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&req).await?;
    stream.flush().await?;

    // Reply: VER REP RSV ATYP BND.ADDR BND.PORT. ATYP determines the
    // variable-length BND.ADDR field; we parse and discard it.
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != VER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: bad CONNECT reply VER=0x{:02x}", head[0]),
        ));
    }
    if head[1] != 0x00 {
        return Err(io::Error::new(
            map_rep_kind(head[1]),
            format!("socks5: CONNECT rejected (REP={})", rep_text(head[1])),
        ));
    }
    // head[2] is RSV; we accept any value, like every SOCKS5 client.
    match head[3] {
        ATYP_IPV4 => {
            let mut skip = [0u8; 4 + 2];
            stream.read_exact(&mut skip).await?;
        }
        ATYP_IPV6 => {
            let mut skip = [0u8; 16 + 2];
            stream.read_exact(&mut skip).await?;
        }
        ATYP_DOMAIN => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            stream.read_exact(&mut skip).await?;
        }
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("socks5: bad CONNECT reply ATYP=0x{other:02x}"),
            ));
        }
    }
    Ok(())
}

/// Map RFC 1928 REP codes to `io::ErrorKind` so callers can branch without
/// re-parsing strings.
fn map_rep_kind(rep: u8) -> io::ErrorKind {
    match rep {
        0x01 => io::ErrorKind::Other,             // general SOCKS server failure
        0x02 => io::ErrorKind::PermissionDenied,  // connection not allowed by ruleset
        0x03 => io::ErrorKind::NetworkUnreachable, // Network unreachable
        0x04 => io::ErrorKind::HostUnreachable,   // Host unreachable
        0x05 => io::ErrorKind::ConnectionRefused, // Connection refused
        0x06 => io::ErrorKind::TimedOut,          // TTL expired
        0x07 => io::ErrorKind::Unsupported,       // Command not supported
        0x08 => io::ErrorKind::Unsupported,       // Address type not supported
        _ => io::ErrorKind::Other,
    }
}

fn rep_text(rep: u8) -> &'static str {
    match rep {
        0x00 => "succeeded",
        0x01 => "general SOCKS server failure",
        0x02 => "connection not allowed by ruleset",
        0x03 => "network unreachable",
        0x04 => "host unreachable",
        0x05 => "connection refused",
        0x06 => "TTL expired",
        0x07 => "command not supported",
        0x08 => "address type not supported",
        _ => "unknown REP",
    }
}

// TODO(test): unit tests for greeting / auth subneg / CONNECT reply parsing
// are intentionally deferred until the transport tree is reorganised so it
// can be exercised on the host. The parent `kernel` module is gated behind
// `#[cfg(target_arch = "wasm32")]`, so host-side `cargo test -p zp-bundle`
// today doesn't see this code at all. Options: (a) hoist `socks5` (and the
// other portable transport layers — http1, future http2 framing, future
// rustls glue) into a `zp-transport` subcrate without the wasm32 cfg gate,
// or (b) wire `wasm-bindgen-test` and run via `wasm-pack test --node`.
// Pick once the layer stack is settled to avoid churning test infra twice.
