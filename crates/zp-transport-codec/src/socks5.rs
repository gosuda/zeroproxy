//! Pure-byte SOCKS5 codec (RFC 1928 + RFC 1929).
//!
//! No async, no allocation beyond `Vec<u8>` for emit buffers, no
//! dependencies. The async wrappers in
//! `zp-bundle/src/kernel/transport/socks5.rs` push these byte buffers
//! over `futures-io` streams and feed reply bytes back into the parsers
//! here. That separation lets every byte-layout invariant
//! (greeting frame shape, CONNECT request format, reply ATYP dispatch,
//! REP error mapping) carry a host-side unit test.

use std::io;

// --- RFC 1928 wire constants -----------------------------------------------

/// SOCKS protocol version byte (RFC 1928 §3).
pub const VER: u8 = 0x05;

/// Method: no authentication required (RFC 1928 §3, METHODS table).
pub const METHOD_NO_AUTH: u8 = 0x00;
/// Method: RFC 1929 username/password sub-negotiation.
pub const METHOD_USER_PASS: u8 = 0x02;
/// Method-selection response indicating no acceptable methods
/// (RFC 1928 §3).
pub const METHOD_NONE_ACCEPTABLE: u8 = 0xFF;

/// Command: CONNECT (RFC 1928 §4).
pub const CMD_CONNECT: u8 = 0x01;
/// Reserved byte (RFC 1928 §4) — must be 0x00 on requests; servers may
/// send any value on replies.
pub const RSV: u8 = 0x00;

/// ATYP: IPv4 (RFC 1928 §4).
pub const ATYP_IPV4: u8 = 0x01;
/// ATYP: DOMAINNAME (RFC 1928 §4).
pub const ATYP_DOMAIN: u8 = 0x03;
/// ATYP: IPv6 (RFC 1928 §4).
pub const ATYP_IPV6: u8 = 0x04;

/// RFC 1929 sub-negotiation version byte.
pub const SUBNEG_VER: u8 = 0x01;
/// RFC 1929 sub-negotiation STATUS = success.
pub const SUBNEG_STATUS_OK: u8 = 0x00;

// --- Auth ------------------------------------------------------------------

/// SOCKS5 authentication mode the client wants to offer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Auth {
    /// Offer NoAuth only. Used by the relay's `-socks internal` mode.
    None,
    /// Offer NoAuth + UsernamePassword. The server picks. Used by Tor's
    /// `IsolateSOCKSAuth` — the strings are circuit keys, not real
    /// credentials. Both 1..=255 bytes.
    UserPassword {
        /// Username string, 1..=255 bytes (validation at build time).
        user: String,
        /// Password string, 1..=255 bytes.
        pass: String,
    },
}

impl Auth {
    /// Methods byte array we will advertise on the greeting (RFC 1928 §3).
    pub fn methods(&self) -> &'static [u8] {
        match self {
            Auth::None => &[METHOD_NO_AUTH],
            Auth::UserPassword { .. } => &[METHOD_NO_AUTH, METHOD_USER_PASS],
        }
    }
}

// --- Greeting (Phase 1) ----------------------------------------------------

/// Emit the RFC 1928 §3 greeting: `VER NMETHODS METHODS…`.
pub fn build_greeting(auth: &Auth) -> Vec<u8> {
    let methods = auth.methods();
    let mut out = Vec::with_capacity(2 + methods.len());
    out.push(VER);
    out.push(methods.len() as u8);
    out.extend_from_slice(methods);
    out
}

/// Decision the client takes after parsing the server's method selection
/// reply (RFC 1928 §3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GreetingNext {
    /// Server picked NO_AUTH; proceed straight to the CONNECT request.
    SendConnect,
    /// Server picked USER_PASS; the client must run the RFC 1929
    /// sub-negotiation next using the credentials carried in `Auth`.
    RunUserPassSubneg,
}

/// Parse the 2-byte greeting reply (`VER METHOD`). Returns the next step
/// the client should take, or an `io::Error` matching the reason
/// `socks5.rs` would surface to the caller (`InvalidData` on a wrong VER
/// or unsupported method, `PermissionDenied` on `0xFF`).
pub fn parse_greeting_reply(reply: [u8; 2], auth: &Auth) -> io::Result<GreetingNext> {
    if reply[0] != VER {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: bad greeting reply VER=0x{:02x}", reply[0]),
        ));
    }
    match reply[1] {
        METHOD_NO_AUTH => Ok(GreetingNext::SendConnect),
        METHOD_USER_PASS => match auth {
            Auth::UserPassword { .. } => Ok(GreetingNext::RunUserPassSubneg),
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

// --- RFC 1929 sub-negotiation ----------------------------------------------

/// Emit the RFC 1929 sub-negotiation request: `VER ULEN UNAME PLEN PASSWD`.
/// Both strings must be 1..=255 bytes (protocol limit).
pub fn build_userpass_subneg(user: &str, pass: &str) -> io::Result<Vec<u8>> {
    if user.is_empty() || user.len() > 255 || pass.is_empty() || pass.len() > 255 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socks5: user/pass must each be 1..=255 bytes",
        ));
    }
    let mut out = Vec::with_capacity(3 + user.len() + pass.len());
    out.push(SUBNEG_VER);
    out.push(user.len() as u8);
    out.extend_from_slice(user.as_bytes());
    out.push(pass.len() as u8);
    out.extend_from_slice(pass.as_bytes());
    Ok(out)
}

/// Parse the 2-byte RFC 1929 sub-negotiation reply (`VER STATUS`). Any
/// non-zero STATUS surfaces as `PermissionDenied`.
pub fn parse_userpass_reply(reply: [u8; 2]) -> io::Result<()> {
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

// --- CONNECT (Phase 2) -----------------------------------------------------

/// Build the CONNECT request with ATYP=DOMAINNAME:
/// `VER CMD RSV ATYP LEN HOST PORT(be u16)`.
/// We intentionally never emit IPv4/IPv6 ATYP — the relay/Tor does DNS
/// so the browser side never leaks resolver behaviour. `host.len()` must
/// fit in a single byte, which every real DNS name does.
pub fn build_connect_request(host: &str, port: u16) -> io::Result<Vec<u8>> {
    if host.is_empty() || host.len() > 255 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socks5: hostname must be 1..=255 bytes",
        ));
    }
    let mut req = Vec::with_capacity(7 + host.len());
    req.push(VER);
    req.push(CMD_CONNECT);
    req.push(RSV);
    req.push(ATYP_DOMAIN);
    req.push(host.len() as u8);
    req.extend_from_slice(host.as_bytes());
    req.extend_from_slice(&port.to_be_bytes());
    Ok(req)
}

/// Outcome of parsing the 4-byte CONNECT reply head (`VER REP RSV ATYP`).
/// `ConnectAtyp` says how many bytes of BND.ADDR + BND.PORT remain to
/// skip on the wire after the head: for IPv4 it's `4 + 2`, for IPv6
/// `16 + 2`, for DOMAINNAME we need one more length byte then `len + 2`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnectAtyp {
    /// IPv4 BND.ADDR (4 bytes) followed by BND.PORT (2 bytes).
    Ipv4,
    /// IPv6 BND.ADDR (16 bytes) followed by BND.PORT (2 bytes).
    Ipv6,
    /// DOMAINNAME — the next byte on the wire is the length prefix; call
    /// [`connect_reply_domain_skip`] once that byte has been read.
    Domain,
}

impl ConnectAtyp {
    /// For fixed-length ATYPs, how many bytes still need to be consumed
    /// from the stream after the 4-byte head. `Domain` returns `None`
    /// because the length isn't known until the next byte.
    pub fn fixed_skip(self) -> Option<usize> {
        match self {
            ConnectAtyp::Ipv4 => Some(4 + 2),
            ConnectAtyp::Ipv6 => Some(16 + 2),
            ConnectAtyp::Domain => None,
        }
    }
}

/// Parse the 4-byte CONNECT reply head. Returns the ATYP so the caller
/// knows how many more bytes to read; a non-zero REP byte surfaces as an
/// `io::Error` matching `socks5.rs`'s `map_rep_kind` / `rep_text` policy.
pub fn parse_connect_reply_head(head: [u8; 4]) -> io::Result<ConnectAtyp> {
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
    // head[2] is RSV; accept any value (matches every other SOCKS5 client).
    match head[3] {
        ATYP_IPV4 => Ok(ConnectAtyp::Ipv4),
        ATYP_IPV6 => Ok(ConnectAtyp::Ipv6),
        ATYP_DOMAIN => Ok(ConnectAtyp::Domain),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("socks5: bad CONNECT reply ATYP=0x{other:02x}"),
        )),
    }
}

/// Given the length byte of a DOMAINNAME BND.ADDR, return how many bytes
/// of `BND.ADDR + BND.PORT` remain on the wire (always `len + 2`).
pub fn connect_reply_domain_skip(len_byte: u8) -> usize {
    len_byte as usize + 2
}

// --- REP code mapping ------------------------------------------------------

/// Map an RFC 1928 REP code to an `io::ErrorKind` so callers can branch
/// without re-parsing strings.
pub fn map_rep_kind(rep: u8) -> io::ErrorKind {
    match rep {
        0x01 => io::ErrorKind::Other,             // general SOCKS server failure
        0x02 => io::ErrorKind::PermissionDenied,  // connection not allowed
        0x03 => io::ErrorKind::NetworkUnreachable, // Network unreachable
        0x04 => io::ErrorKind::HostUnreachable,   // Host unreachable
        0x05 => io::ErrorKind::ConnectionRefused, // Connection refused
        0x06 => io::ErrorKind::TimedOut,          // TTL expired
        0x07 => io::ErrorKind::Unsupported,       // Command not supported
        0x08 => io::ErrorKind::Unsupported,       // Address type not supported
        _ => io::ErrorKind::Other,
    }
}

/// Human-readable REP description (used by the wasm wrapper's error text).
pub fn rep_text(rep: u8) -> &'static str {
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

// --- Tests -----------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greeting_noauth_layout() {
        assert_eq!(build_greeting(&Auth::None), vec![0x05, 0x01, 0x00]);
    }

    #[test]
    fn greeting_userpass_offers_both_methods() {
        let g = build_greeting(&Auth::UserPassword {
            user: "u".into(),
            pass: "p".into(),
        });
        // VER, NMETHODS=2, NO_AUTH, USER_PASS — NoAuth first so a server
        // that supports both takes the cheaper one.
        assert_eq!(g, vec![0x05, 0x02, 0x00, 0x02]);
    }

    #[test]
    fn greeting_reply_noauth_picks_connect() {
        let next = parse_greeting_reply([0x05, 0x00], &Auth::None).expect("ok");
        assert_eq!(next, GreetingNext::SendConnect);
    }

    #[test]
    fn greeting_reply_userpass_picks_subneg() {
        let next = parse_greeting_reply(
            [0x05, 0x02],
            &Auth::UserPassword { user: "u".into(), pass: "p".into() },
        )
        .expect("ok");
        assert_eq!(next, GreetingNext::RunUserPassSubneg);
    }

    #[test]
    fn greeting_reply_userpass_with_none_auth_rejects() {
        let err = parse_greeting_reply([0x05, 0x02], &Auth::None).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn greeting_reply_no_acceptable_rejects() {
        let err = parse_greeting_reply([0x05, 0xFF], &Auth::None).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn greeting_reply_unsupported_method_rejects() {
        let err = parse_greeting_reply([0x05, 0x03], &Auth::None).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn greeting_reply_wrong_version_rejects() {
        let err = parse_greeting_reply([0x04, 0x00], &Auth::None).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn userpass_subneg_layout() {
        let buf = build_userpass_subneg("alice", "x").expect("ok");
        // VER, ULEN=5, "alice", PLEN=1, "x"
        assert_eq!(
            buf,
            vec![0x01, 0x05, b'a', b'l', b'i', b'c', b'e', 0x01, b'x']
        );
    }

    #[test]
    fn userpass_subneg_empty_user_rejected() {
        assert_eq!(
            build_userpass_subneg("", "p").expect_err("must fail").kind(),
            io::ErrorKind::InvalidInput,
        );
    }

    #[test]
    fn userpass_subneg_long_user_rejected() {
        let long_user: String = "u".repeat(256);
        assert_eq!(
            build_userpass_subneg(&long_user, "p").expect_err("must fail").kind(),
            io::ErrorKind::InvalidInput,
        );
    }

    #[test]
    fn userpass_reply_ok() {
        parse_userpass_reply([0x01, 0x00]).expect("ok");
    }

    #[test]
    fn userpass_reply_bad_status_rejects() {
        let err = parse_userpass_reply([0x01, 0x01]).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn userpass_reply_wrong_version_rejects() {
        let err = parse_userpass_reply([0x00, 0x00]).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn connect_request_domain_layout() {
        let r = build_connect_request("example.com", 443).expect("ok");
        // VER CMD RSV ATYP=3 LEN=11 example.com PORT=01BB
        assert_eq!(
            r,
            vec![
                0x05, 0x01, 0x00, 0x03, 0x0B, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.', b'c',
                b'o', b'm', 0x01, 0xBB,
            ]
        );
    }

    #[test]
    fn connect_request_empty_host_rejected() {
        assert_eq!(
            build_connect_request("", 443).expect_err("must fail").kind(),
            io::ErrorKind::InvalidInput,
        );
    }

    #[test]
    fn connect_request_long_host_rejected() {
        let host = "a".repeat(256);
        assert_eq!(
            build_connect_request(&host, 443).expect_err("must fail").kind(),
            io::ErrorKind::InvalidInput,
        );
    }

    #[test]
    fn connect_reply_head_ipv4() {
        let atyp = parse_connect_reply_head([0x05, 0x00, 0x00, 0x01]).expect("ok");
        assert_eq!(atyp, ConnectAtyp::Ipv4);
        assert_eq!(atyp.fixed_skip(), Some(6));
    }

    #[test]
    fn connect_reply_head_ipv6() {
        let atyp = parse_connect_reply_head([0x05, 0x00, 0x00, 0x04]).expect("ok");
        assert_eq!(atyp, ConnectAtyp::Ipv6);
        assert_eq!(atyp.fixed_skip(), Some(18));
    }

    #[test]
    fn connect_reply_head_domain() {
        let atyp = parse_connect_reply_head([0x05, 0x00, 0x77, 0x03]).expect("ok");
        // head[2] (RSV) intentionally non-zero — we accept any value.
        assert_eq!(atyp, ConnectAtyp::Domain);
        assert_eq!(atyp.fixed_skip(), None);
        assert_eq!(connect_reply_domain_skip(11), 13);
    }

    #[test]
    fn connect_reply_head_wrong_version_rejects() {
        let err = parse_connect_reply_head([0x04, 0x00, 0x00, 0x01]).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn connect_reply_head_unknown_atyp_rejects() {
        let err = parse_connect_reply_head([0x05, 0x00, 0x00, 0x07]).expect_err("must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn connect_reply_head_rep_mapping_covers_rfc_1928_table() {
        // §6 REP table → io::ErrorKind. Validates the entire mapping by
        // round-tripping through parse_connect_reply_head so any future
        // change to map_rep_kind shows up here.
        let cases = [
            (0x01u8, io::ErrorKind::Other),
            (0x02u8, io::ErrorKind::PermissionDenied),
            (0x03u8, io::ErrorKind::NetworkUnreachable),
            (0x04u8, io::ErrorKind::HostUnreachable),
            (0x05u8, io::ErrorKind::ConnectionRefused),
            (0x06u8, io::ErrorKind::TimedOut),
            (0x07u8, io::ErrorKind::Unsupported),
            (0x08u8, io::ErrorKind::Unsupported),
            (0x09u8, io::ErrorKind::Other), // unspecified → Other
        ];
        for (rep, expected) in cases {
            let err =
                parse_connect_reply_head([0x05, rep, 0x00, 0x01]).expect_err("must fail");
            assert_eq!(err.kind(), expected, "REP=0x{:02x}", rep);
            // Error message must include the rep_text symbol so the
            // wasm wrapper's diagnostic surface stays human-readable.
            let msg = format!("{err}");
            assert!(msg.contains(rep_text(rep)), "missing rep_text for 0x{rep:02x}: {msg}");
        }
    }
}
