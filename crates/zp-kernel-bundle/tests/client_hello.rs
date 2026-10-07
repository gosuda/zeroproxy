// The first flight the SW's captured spec produces, read back off the wire format.
//
// Real Chrome 154's ClientHello (captured 2026-10-07 from Chrome 154.0.8037.98 against a local TCP listener, three
// connections) has these 17 extensions besides its two GREASE ones — and WebView2/Edge's has all but `trust_anchors`
// (0xca34, TLS Trust Expressions). We had matched WebView2's, with a Chrome user-agent on top: Cloudflare saw "Chrome
// without trust_anchors" and answered with its full managed challenge instead of the light one (Stack Overflow).
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

fn first_flight() -> Vec<u8> {
    let b64 = sw_spec_b64();
    // The spec and the generators are thread-local: a fresh thread per hello, nothing carries over.
    std::thread::spawn(move || {
        rustls::ja3::set_captured_spec(captured_spec(&b64));
        let mut config = ClientConfig::builder_with_provider(Arc::new(rustls_rustcrypto::provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(RootCertStore::empty())
            .with_no_client_auth();
        config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let mut conn = ClientConnection::new(Arc::new(config), ServerName::try_from("example.com").unwrap()).unwrap();
        let mut out = Vec::new();
        while conn.wants_write() {
            conn.write_tls(&mut out).unwrap();
        }
        out
    })
    .join()
    .unwrap()
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
    let chrome_154: Vec<u16> = vec![
        0x0000, 0x0005, 0x000a, 0x000b, 0x000d, 0x0010, 0x0012, 0x0017, 0x001b, 0x0023, 0x002b, 0x002d, 0x0033,
        0x44cd, 0xca34, 0xfe0d, 0xff01,
    ];
    assert_eq!(real, chrome_154, "the extension set drifted from Chrome 154's");
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
