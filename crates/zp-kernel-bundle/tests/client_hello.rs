// The first flight the SW's captured spec produces, read back off the wire format.
//
// Chrome 155's ClientHello includes 17 non-GREASE extensions, including
// `trust_anchors` (0xca34, TLS Trust Expressions), plus a GREASE extension at
// each end.
use std::sync::Arc;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use base64::Engine;

const SW_JS: &str = include_str!("../../../web/sw.js");

fn sw_spec_b64() -> String {
    let marker = "const CAPTURED_FINGERPRINT_B64 = '";
    let start = SW_JS.find(marker).expect("the SW no longer carries its captured spec") + marker.len();
    let end = start + SW_JS[start..].find('\'').unwrap();
    SW_JS[start..end].to_string()
}

/// The kernel's own parse of the spec (`kernel::captured_spec_from_json`; the crate is wasm-only, so it is mirrored here).
fn captured_spec(b64: &str) -> rustls::ja3::CapturedSpec {
    let j: serde_json::Value = serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(b64).unwrap()).unwrap();
    let arr = |key: &str| -> Vec<u16> { j[key].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u16).collect() };
    rustls::ja3::CapturedSpec {
        versions: arr("supportedVersions"),
        cipher_suites: arr("cipherSuites").into_iter().map(rustls::CipherSuite::from).collect(),
        extensions: arr("extensions").into_iter().map(rustls::ja3::ExtensionType::from).collect(),
        named_groups: arr("supportedCurves").into_iter().map(rustls::NamedGroup::from).collect(),
        ec_point_formats: base64::engine::general_purpose::STANDARD.decode(j["supportedPoints"].as_str().unwrap()).unwrap(),
        signature_schemes: arr("signatureSchemes"),
        alpn_protocols: j["alpnProtocols"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().as_bytes().to_vec()).collect(),
    }
}

/// A client connection as the kernel builds one, with the SW's captured spec installed on the current thread (the spec and the generators are thread-local).
fn client(advertise_unimplemented_suites: bool) -> ClientConnection {
    rustls::ja3::set_captured_spec(captured_spec(&sw_spec_b64()));
    let mut config = ClientConfig::builder_with_provider(Arc::new(rustls_rustcrypto::provider()))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config.advertise_unimplemented_suites = advertise_unimplemented_suites;
    ClientConnection::new(Arc::new(config), ServerName::try_from("example.com").unwrap()).unwrap()
}

fn flight_of(conn: &mut ClientConnection) -> Vec<u8> {
    let mut out = Vec::new();
    while conn.wants_write() {
        conn.write_tls(&mut out).unwrap();
    }
    out
}

fn first_flight_with(advertise_unimplemented_suites: bool) -> Vec<u8> {
    // A fresh thread per hello: nothing carries over.
    std::thread::spawn(move || flight_of(&mut client(advertise_unimplemented_suites))).join().unwrap()
}

fn first_flight() -> Vec<u8> {
    first_flight_with(true)
}

/// The ClientHello record's cipher suites, GREASE included.
fn cipher_suites(record: &[u8]) -> Vec<u16> {
    let p = 5 + 4 + 2 + 32;
    let p = p + 1 + record[p] as usize; // session id
    let n = u16::from_be_bytes([record[p], record[p + 1]]) as usize;
    record[p + 2..p + 2 + n].chunks(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect()
}

/// The ClientHello record's extensions as (type, body).
fn extensions(record: &[u8]) -> Vec<(u16, Vec<u8>)> {
    assert_eq!(record[0], 0x16, "not a handshake record");
    assert_eq!(record[5], 0x01, "not a ClientHello");
    let mut p = 5 + 4 + 2 + 32;
    p += 1 + record[p] as usize; // session id
    p += 2 + u16::from_be_bytes([record[p], record[p + 1]]) as usize; // cipher suites
    p += 1 + record[p] as usize; // compression
    let total = u16::from_be_bytes([record[p], record[p + 1]]) as usize;
    p += 2;
    let end = p + total;
    let mut out = Vec::new();
    while p + 4 <= end {
        let t = u16::from_be_bytes([record[p], record[p + 1]]);
        let l = u16::from_be_bytes([record[p + 2], record[p + 3]]) as usize;
        out.push((t, record[p + 4..p + 4 + l].to_vec()));
        p += 4 + l;
    }
    out
}

fn is_grease(t: u16) -> bool {
    t & 0x0f0f == 0x0a0a && (t >> 8) == (t & 0xff)
}

#[test]
fn the_hello_has_the_extension_set_of_a_real_chrome() {
    let exts = extensions(&first_flight());
    let mut real: Vec<u16> = exts.iter().map(|(t, _)| *t).filter(|t| !is_grease(*t)).collect();
    real.sort_unstable();
    let chrome_155: Vec<u16> = vec![
        0x0000, 0x0005, 0x000a, 0x000b, 0x000d, 0x0010, 0x0012, 0x0017, 0x001b, 0x0023, 0x002b, 0x002d, 0x0033,
        0x44cd, 0xca34, 0xfe0d, 0xff01,
    ];
    assert_eq!(real, chrome_155, "the extension set drifted from Chrome 155's");
    assert_eq!(exts.iter().filter(|(t, _)| is_grease(*t)).count(), 2, "a GREASE extension at each end");
    assert!(is_grease(exts.first().unwrap().0) && is_grease(exts.last().unwrap().0));
}

#[test]
fn trust_anchors_is_the_body_chrome_sends() {
    let exts = extensions(&first_flight());
    let body = &exts.iter().find(|(t, _)| *t == 0xca34).expect("no trust_anchors extension").1;
    assert_eq!(body.as_slice(), &rustls::ja3::CHROME_TRUST_ANCHORS[..]);
    assert_eq!(body.len(), 186);
    assert_eq!(u16::from_be_bytes([body[0], body[1]]) as usize, body.len() - 2, "the list length prefix");
}

/// Chrome's legacy suites the TLS stack cannot negotiate: ECDHE-RSA with AES-CBC-SHA, AES-GCM with static RSA, AES-CBC-SHA with static RSA.
const LEGACY: [u16; 6] = [0xc013, 0xc014, 0x009c, 0x009d, 0x002f, 0x0035];

#[test]
fn the_browser_shaped_hello_lists_the_legacy_suites_and_the_plain_one_does_not() {
    let shaped = cipher_suites(&first_flight_with(true));
    let plain = cipher_suites(&first_flight_with(false));
    for suite in LEGACY {
        assert!(shaped.contains(&suite), "the browser-shaped hello lost {suite:#06x}");
        assert!(!plain.contains(&suite), "the plain hello still lists {suite:#06x}");
    }
    // What can be negotiated stays, in the order it was captured: the plain hello is the shaped one without the legacy suites.
    let real = |list: &[u16]| list.iter().copied().filter(|s| !is_grease(*s) && !LEGACY.contains(s)).collect::<Vec<_>>();
    assert_eq!(real(&plain), real(&shaped));
    for aead in [0x1301, 0x1302, 0x1303, 0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8] {
        assert!(plain.contains(&aead), "the plain hello lost {aead:#06x}");
    }
    assert!(plain.iter().any(|s| is_grease(*s)), "the plain hello keeps its GREASE suite");
    // The extension set is the same either way: only the suite list differs (their order is shuffled per hello, as Chrome's is).
    let ext_types = |flight: &[u8]| {
        let mut types = extensions(flight).iter().map(|(t, _)| *t).filter(|t| !is_grease(*t)).collect::<Vec<_>>();
        types.sort_unstable();
        types
    };
    assert_eq!(ext_types(&first_flight_with(true)), ext_types(&first_flight_with(false)));
}

/// A TLS 1.2 ServerHello that selects `suite` and echoes the session id, as a record.
fn server_hello_selecting(suite: u16, session_id: &[u8]) -> Vec<u8> {
    let mut body = vec![0x03, 0x03];
    body.extend_from_slice(&[0x42; 32]);
    body.push(session_id.len() as u8);
    body.extend_from_slice(session_id);
    body.extend_from_slice(&suite.to_be_bytes());
    body.push(0); // compression: null
    body.extend_from_slice(&[0x00, 0x05, 0xff, 0x01, 0x00, 0x01, 0x00]); // renegotiation_info, empty
    let mut hs = vec![0x02, 0, (body.len() >> 8) as u8, body.len() as u8];
    hs.extend_from_slice(&body);
    let mut rec = vec![0x16, 0x03, 0x03, (hs.len() >> 8) as u8, hs.len() as u8];
    rec.extend_from_slice(&hs);
    rec
}

#[test]
fn a_server_that_picks_a_legacy_suite_fails_with_the_error_the_retry_keys_on() {
    // The kernel retries with the plain hello only for this error (`tls::is_unoffered_suite` matches it by type): pin that rustls reports a legacy pick as exactly it,
    // and that a pick the plain hello offered (ECDHE-RSA-AES128-GCM-SHA256) is not that error.
    let outcome = |advertise: bool, suite: u16| {
        std::thread::spawn(move || {
            let mut conn = client(advertise);
            let flight = flight_of(&mut conn);
            let p = 5 + 4 + 2 + 32;
            let session_id = flight[p + 1..p + 1 + flight[p] as usize].to_vec();
            let mut reply: &[u8] = &server_hello_selecting(suite, &session_id);
            conn.read_tls(&mut reply).unwrap();
            conn.process_new_packets().err()
        })
        .join()
        .unwrap()
    };
    let unoffered = Some(rustls::Error::PeerMisbehaved(rustls::PeerMisbehaved::SelectedUnofferedCipherSuite));
    for suite in [0xc014, 0xc013, 0x002f] {
        assert_eq!(outcome(true, suite), unoffered, "{suite:#06x} picked after the shaped hello");
        assert_eq!(outcome(false, suite), unoffered, "{suite:#06x} picked after the plain hello (the server broke the rules there)");
    }
    let ok = outcome(false, 0xc02f);
    assert_ne!(ok, unoffered, "an offered suite is not refused as unoffered: {ok:?}");
}
