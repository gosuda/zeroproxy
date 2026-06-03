use aes::Aes256;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use cbc::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::cell::RefCell;
use std::collections::HashSet;
use std::io::{self, BufReader, Read};
use std::net::IpAddr;
use url::Url;

type Aes256CbcEnc = cbc::Encryptor<Aes256>;
type HmacSha256 = Hmac<Sha256>;

const CONTROL_PREFIX: &str = "/zp/";
const SHARE_INFO_ENC: &[u8] = b"zp-url-cbc-enc";
const SHARE_INFO_MAC: &[u8] = b"zp-url-cbc-mac";
const SHARE_MAC_PREFIX: &[u8] = b"ZP-CBC-URL-V1";
const MAX_RELAY_SERVERS: usize = 8;
const MAX_RELAY_SERVER_BYTES: usize = 2048;
const SEED_LEN: usize = 64;
const IV_LEN: usize = 16;
const RANDOM_BUFFER_SIZE: usize = 32 * 1024;

thread_local! {
    static RANDOM_READER: RefCell<BufReader<GetRandomReader>> =
        RefCell::new(BufReader::with_capacity(RANDOM_BUFFER_SIZE, GetRandomReader));
}

struct GetRandomReader;

impl Read for GetRandomReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        getrandom::getrandom(buf).map_err(|err| io::Error::other(err.to_string()))?;
        Ok(buf.len())
    }
}

pub(crate) fn new_with_servers(target: &str, servers: &[String]) -> Result<String, String> {
    let mut random = [0u8; SEED_LEN + IV_LEN];
    fill_random(&mut random)?;
    new_with_seed_iv_and_servers(target, servers, &random[..SEED_LEN], &random[SEED_LEN..])
}

fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    RANDOM_READER.with(|reader| {
        reader
            .borrow_mut()
            .read_exact(buf)
            .map_err(|err| err.to_string())
    })
}

pub(crate) fn new_with_seed_iv_and_servers(
    target: &str,
    servers: &[String],
    seed: &[u8],
    iv: &[u8],
) -> Result<String, String> {
    if seed.len() != SEED_LEN || iv.len() != IV_LEN {
        return Err("shareurl: invalid random material".to_string());
    }
    let target = validate_target(target)?;
    let encrypted = seal_token(seed, iv, &target)?;
    let fragment = share_fragment(&URL_SAFE_NO_PAD.encode(seed), servers)?;
    Ok(format!("{CONTROL_PREFIX}p/{encrypted}{fragment}"))
}

fn validate_target(target: &str) -> Result<String, String> {
    let parsed = Url::parse(target).map_err(|_| "shareurl: unsupported target URL".to_string())?;
    if parsed.host_str().is_none() || !matches!(parsed.scheme(), "http" | "https") {
        return Err("shareurl: unsupported target URL".to_string());
    }
    Ok(go_style_target_string(target))
}

fn go_style_target_string(target: &str) -> String {
    target.to_string()
}

fn seal_token(seed: &[u8], iv: &[u8], target: &str) -> Result<String, String> {
    let enc_key = derive(seed, SHARE_INFO_ENC);
    let mac_key = derive(seed, SHARE_INFO_MAC);
    let ciphertext = Aes256CbcEnc::new_from_slices(&enc_key, iv)
        .map_err(|_| "shareurl: encryption failed".to_string())?
        .encrypt_padded_vec_mut::<Pkcs7>(target.as_bytes());

    let mut mac = HmacSha256::new_from_slice(&mac_key)
        .map_err(|_| "shareurl: encryption failed".to_string())?;
    mac.update(SHARE_MAC_PREFIX);
    mac.update(iv);
    mac.update(&ciphertext);
    let tag = mac.finalize().into_bytes();

    let mut blob = Vec::with_capacity(iv.len() + ciphertext.len() + tag.len());
    blob.extend_from_slice(iv);
    blob.extend_from_slice(&ciphertext);
    blob.extend_from_slice(&tag);
    Ok(URL_SAFE_NO_PAD.encode(blob))
}

fn derive(seed: &[u8], info: &[u8]) -> [u8; 32] {
    let hk = hkdf::Hkdf::<Sha256>::new(None, seed);
    let mut key = [0u8; 32];
    hk.expand(info, &mut key)
        .expect("HKDF-SHA256 32-byte output is valid");
    key
}

fn share_fragment(key: &str, servers: &[String]) -> Result<String, String> {
    let normalized = normalize_relay_servers(servers)?;
    let mut out = format!("#k={}", form_encode(key));
    for server in normalized {
        out.push_str("&server=");
        out.push_str(&form_encode(&server));
    }
    Ok(out)
}

fn normalize_relay_servers(values: &[String]) -> Result<Vec<String>, String> {
    if values.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut total = 0usize;
    for raw in values {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        if out.len() >= MAX_RELAY_SERVERS {
            return Err("shareurl: too many relay servers".to_string());
        }
        let url = validate_relay_url(value)?;
        let normalized = canonicalize_relay_url(&url)?;
        total += normalized.len();
        if total > MAX_RELAY_SERVER_BYTES {
            return Err("shareurl: relay server list too large".to_string());
        }
        if seen.insert(normalized.clone()) {
            out.push(normalized);
        }
    }
    Ok(out)
}

fn validate_relay_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "shareurl: malformed relay server".to_string())?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("shareurl: malformed relay server".to_string());
    }
    if url.fragment().is_some() {
        return Err("shareurl: malformed relay server".to_string());
    }
    match url.scheme() {
        "wss" => Ok(url),
        "ws" if is_loopback_host(url.host_str().unwrap_or_default()) => Ok(url),
        "ws" => Err("shareurl: insecure relay server".to_string()),
        _ => Err("shareurl: unsupported relay server".to_string()),
    }
}

fn canonicalize_relay_url(url: &Url) -> Result<String, String> {
    let host = url
        .host_str()
        .ok_or_else(|| "shareurl: malformed relay server".to_string())?
        .to_ascii_lowercase();
    let port = match (url.scheme(), url.port()) {
        ("wss", Some(443)) | ("ws", Some(80)) | (_, None) => None,
        (_, value) => value,
    };
    let host_port = canonical_host_port(&host, port);
    let path = if url.path().is_empty() {
        "/"
    } else {
        url.path()
    };
    let mut out = format!("{}://{}{}", url.scheme(), host_port, path);
    if let Some(query) = url.query() {
        out.push('?');
        out.push_str(query);
    }
    Ok(out)
}

fn canonical_host_port(host: &str, port: Option<u16>) -> String {
    match port {
        Some(port) if host.contains(':') => format!("[{host}]:{port}"),
        Some(port) => format!("{host}:{port}"),
        None if host.contains(':') => format!("[{host}]"),
        None => host.to_string(),
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host
        .trim_matches(|ch| matches!(ch, '[' | ']'))
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|addr| addr.is_loopback())
        .unwrap_or(false)
}

fn form_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_seed() -> [u8; SEED_LEN] {
        [b'x'; SEED_LEN]
    }

    fn fixed_iv() -> [u8; IV_LEN] {
        [b'x'; IV_LEN]
    }

    #[test]
    fn golden_paths_match_go_shareurl() {
        let cases = [
            (
                "https://example.com/path?q=1#frag",
                vec![],
                "/zp/p/eHh4eHh4eHh4eHh4eHh4eIRIkG1kf2-7MFSHXtEOyKsGTPBGny25c3KxeManFS88nq7MV4yF8_MwR6ghGmIXmT_motZWmAqxtGPEBz4FjkXCM1O5VlrfyudrlmRcc8IL#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
            ),
            (
                "https://example.com/path",
                vec![
                    "wss://relay.example:443/ws".to_string(),
                    "wss://relay.example/ws".to_string(),
                    "ws://proxy.localhost:8080/zp/ws-pipe".to_string(),
                ],
                "/zp/p/eHh4eHh4eHh4eHh4eHh4eIRIkG1kf2-7MFSHXtEOyKvBwni9ryndDvRCNNPp9x6foyLSYfD7xtgdO0GwsRK82SpJmr2XaXriQYqZ_0WtGIE#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA&server=wss%3A%2F%2Frelay.example%2Fws&server=ws%3A%2F%2Fproxy.localhost%3A8080%2Fzp%2Fws-pipe",
            ),
            (
                "http://example.com/",
                vec![],
                "/zp/p/eHh4eHh4eHh4eHh4eHh4eGD2wwf3pssbrhy-l3jPIAgaCd6Z87IeXesaMtPJQEtSkdyZL3aPjYZUVOznQI9cZXXd4njoLKkoVRGEkQj9ZFA#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
            ),
            (
                "http://example.com",
                vec![],
                "/zp/p/eHh4eHh4eHh4eHh4eHh4eGD2wwf3pssbrhy-l3jPIAjAUisyTCe0qFeTsfORYzevSK5mx5BVsZqMf75u4Aw7feQqCLBSrYzVZfY4YjMVaGQ#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
            ),
            (
                "https://Example.COM/Path",
                vec![],
                "/zp/p/eHh4eHh4eHh4eHh4eHh4eOHWWxMahmbnZOqSVnxNx60uARvcXfqSKHrLqYfzIZgccQp1jClyl08hr1z-ULtAg4OewgvRse10iid1vln1r9I#k=eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eA",
            ),
        ];
        for (target, servers, want) in cases {
            let got =
                new_with_seed_iv_and_servers(target, &servers, &fixed_seed(), &fixed_iv()).unwrap();
            assert_eq!(got, want, "{target}");
        }
    }

    #[test]
    fn rejects_unsupported_targets_and_relays_like_go() {
        for target in [
            "",
            "://bad",
            "ws://example.com/socket",
            "wss://example.com/socket",
            "javascript:alert(1)",
            "data:text/html,hi",
            "/relative",
            "https://",
        ] {
            assert_eq!(
                new_with_seed_iv_and_servers(target, &[], &fixed_seed(), &fixed_iv()).unwrap_err(),
                "shareurl: unsupported target URL"
            );
        }
        assert_eq!(
            new_with_seed_iv_and_servers(
                "https://h/",
                &["ws://example.com/x".to_string()],
                &fixed_seed(),
                &fixed_iv(),
            )
            .unwrap_err(),
            "shareurl: insecure relay server"
        );
    }
}
