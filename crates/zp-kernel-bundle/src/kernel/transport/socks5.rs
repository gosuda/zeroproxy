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
//!
//! ## Where the bytes are defined
//!
//! Every byte-layout invariant (greeting frame, CONNECT request shape,
//! reply ATYP dispatch, REP error mapping) lives in
//! [`zp_transport_codec::socks5`] and is unit-tested on the host. This
//! module is the thin async wrapper that pushes those buffers through a
//! `futures-io` stream and feeds reply bytes back into the codec parsers.

use std::io;

use futures_util::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub use zp_transport_codec::socks5::Auth;

use zp_transport_codec::socks5 as codec;

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
    let greeting = codec::build_greeting(auth);
    stream.write_all(&greeting).await?;
    stream.flush().await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    match codec::parse_greeting_reply(reply, auth)? {
        codec::GreetingNext::SendConnect => Ok(()),
        codec::GreetingNext::RunUserPassSubneg => {
            // parse_greeting_reply already verified auth is UserPassword.
            let Auth::UserPassword { user, pass } = auth else {
                unreachable!("codec::parse_greeting_reply guarantees UserPassword here");
            };
            userpass_subneg(stream, user, pass).await
        }
    }
}

/// RFC 1929 username/password sub-negotiation. Lengths bounded to 255 by
/// the codec.
async fn userpass_subneg<S>(stream: &mut S, user: &str, pass: &str) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let buf = codec::build_userpass_subneg(user, pass)?;
    stream.write_all(&buf).await?;
    stream.flush().await?;

    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await?;
    codec::parse_userpass_reply(reply)
}

/// Phase 2: CONNECT request + reply parsing. On success the stream is now
/// a transparent byte pipe to `host:port`.
async fn request_connect<S>(stream: &mut S, host: &str, port: u16) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let req = codec::build_connect_request(host, port)?;
    stream.write_all(&req).await?;
    stream.flush().await?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await?;
    match codec::parse_connect_reply_head(head)? {
        atyp @ (codec::ConnectAtyp::Ipv4 | codec::ConnectAtyp::Ipv6) => {
            // Fixed-length BND.ADDR + BND.PORT — codec tells us how much.
            let skip = atyp.fixed_skip().expect("fixed ATYP has known skip");
            let mut buf = vec![0u8; skip];
            stream.read_exact(&mut buf).await?;
        }
        codec::ConnectAtyp::Domain => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let skip = codec::connect_reply_domain_skip(len[0]);
            let mut buf = vec![0u8; skip];
            stream.read_exact(&mut buf).await?;
        }
    }
    Ok(())
}
