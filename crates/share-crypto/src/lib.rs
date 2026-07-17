use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use sha2::{Digest, Sha256};
use thiserror::Error;
use url::Url;
use wasm_bindgen::prelude::*;
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Share {
    pub target_url: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub relay_profile_digest: Option<Vec<u8>>,
    pub requested_profile_mode: String,
    pub flags: u64,
}
#[derive(Debug, Error, Eq, PartialEq)]
pub enum Error {
    #[error("invalid share")]
    Invalid,
    #[error("expired share")]
    Expired,
    #[error("cryptographic failure")]
    Crypto,
    #[error("oversize share")]
    Oversize,
}
fn validate(record: &Share, now: u64) -> Result<(), Error> {
    if record.target_url.len() > 8192
        || !matches!(
            record.requested_profile_mode.as_str(),
            "ephemeral" | "persistent"
        )
    {
        return Err(Error::Invalid);
    }
    let url = Url::parse(&record.target_url).map_err(|_| Error::Invalid)?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Error::Invalid);
    }
    if record.expires_at.is_some_and(|expiry| expiry <= now) {
        return Err(Error::Expired);
    }
    Ok(())
}
fn encode(record: &Share) -> Result<Vec<u8>, Error> {
    let mut out = Vec::new();
    let mut enc = minicbor::Encoder::new(&mut out);
    enc.map(7)
        .map_err(|_| Error::Invalid)?
        .str("v")
        .map_err(|_| Error::Invalid)?
        .u8(2)
        .map_err(|_| Error::Invalid)?
        .str("flags")
        .map_err(|_| Error::Invalid)?
        .u64(record.flags)
        .map_err(|_| Error::Invalid)?
        .str("created_at")
        .map_err(|_| Error::Invalid)?
        .u64(record.created_at)
        .map_err(|_| Error::Invalid)?
        .str("expires_at")
        .map_err(|_| Error::Invalid)?;
    match record.expires_at {
        Some(value) => enc.u64(value).map_err(|_| Error::Invalid)?,
        None => enc.null().map_err(|_| Error::Invalid)?,
    };
    enc.str("target_url")
        .map_err(|_| Error::Invalid)?
        .str(&record.target_url)
        .map_err(|_| Error::Invalid)?
        .str("relay_profile_digest")
        .map_err(|_| Error::Invalid)?;
    match &record.relay_profile_digest {
        Some(value) => enc.bytes(value).map_err(|_| Error::Invalid)?,
        None => enc.null().map_err(|_| Error::Invalid)?,
    };
    enc.str("requested_profile_mode")
        .map_err(|_| Error::Invalid)?
        .str(&record.requested_profile_mode)
        .map_err(|_| Error::Invalid)?;
    Ok(out)
}
fn decode(bytes: &[u8]) -> Result<Share, Error> {
    let mut d = minicbor::Decoder::new(bytes);
    if d.map().map_err(|_| Error::Invalid)? != Some(7) {
        return Err(Error::Invalid);
    }
    let mut target = None;
    let (mut created, mut expires, mut relay, mut mode, mut flags, mut version) =
        (None, None, None, None, None, None);
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..7 {
        let key = d.str().map_err(|_| Error::Invalid)?;
        if !seen.insert(key.to_owned()) {
            return Err(Error::Invalid);
        }
        match key {
            "v" => version = Some(d.u8().map_err(|_| Error::Invalid)?),
            "target_url" => target = Some(d.str().map_err(|_| Error::Invalid)?.to_owned()),
            "created_at" => created = Some(d.u64().map_err(|_| Error::Invalid)?),
            "expires_at" => {
                expires = Some(
                    if d.datatype().map_err(|_| Error::Invalid)? == minicbor::data::Type::Null {
                        d.skip().map_err(|_| Error::Invalid)?;
                        None
                    } else {
                        Some(d.u64().map_err(|_| Error::Invalid)?)
                    },
                )
            }
            "relay_profile_digest" => {
                relay = Some(
                    if d.datatype().map_err(|_| Error::Invalid)? == minicbor::data::Type::Null {
                        d.skip().map_err(|_| Error::Invalid)?;
                        None
                    } else {
                        Some(d.bytes().map_err(|_| Error::Invalid)?.to_vec())
                    },
                )
            }
            "requested_profile_mode" => {
                mode = Some(d.str().map_err(|_| Error::Invalid)?.to_owned())
            }
            "flags" => flags = Some(d.u64().map_err(|_| Error::Invalid)?),
            _ => return Err(Error::Invalid),
        }
    }
    if d.position() != bytes.len() || version != Some(2) {
        return Err(Error::Invalid);
    }
    Ok(Share {
        target_url: target.ok_or(Error::Invalid)?,
        created_at: created.ok_or(Error::Invalid)?,
        expires_at: expires.ok_or(Error::Invalid)?,
        relay_profile_digest: relay.ok_or(Error::Invalid)?,
        requested_profile_mode: mode.ok_or(Error::Invalid)?,
        flags: flags.ok_or(Error::Invalid)?,
    })
}
pub fn seal(record: &Share, control_origin: &str) -> Result<(String, [u8; 32]), Error> {
    validate(record, record.created_at)?;
    let mut key = [0; 32];
    rand::rng().fill_bytes(&mut key);
    let mut nonce = [0; 12];
    rand::rng().fill_bytes(&mut nonce);
    let aad = format!(
        "ZeroProxy Share V2\0{}",
        Url::parse(control_origin)
            .map_err(|_| Error::Invalid)?
            .origin()
            .ascii_serialization()
    );
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| Error::Crypto)?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &encode(record)?,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| Error::Crypto)?;
    let mut envelope = nonce.to_vec();
    envelope.extend(cipher);
    let path = format!(
        "/_zp/s/v2/{}#k={}",
        URL_SAFE_NO_PAD.encode(envelope),
        URL_SAFE_NO_PAD.encode(key)
    );
    if path.len() > 16 * 1024 {
        return Err(Error::Oversize);
    }
    Ok((path, key))
}
pub fn open(path: &str, control_origin: &str, now: u64) -> Result<Share, Error> {
    let url = Url::parse(control_origin)
        .map_err(|_| Error::Invalid)?
        .join(path)
        .map_err(|_| Error::Invalid)?;
    let prefix = "/_zp/s/v2/";
    let envelope = URL_SAFE_NO_PAD
        .decode(url.path().strip_prefix(prefix).ok_or(Error::Invalid)?)
        .map_err(|_| Error::Invalid)?;
    let key_text = url
        .fragment()
        .and_then(|fragment| fragment.strip_prefix("k="))
        .ok_or(Error::Invalid)?;
    let key = URL_SAFE_NO_PAD
        .decode(key_text)
        .map_err(|_| Error::Invalid)?;
    if envelope.len() < 29 || key.len() != 32 {
        return Err(Error::Invalid);
    }
    let aad = format!("ZeroProxy Share V2\0{}", url.origin().ascii_serialization());
    let plain = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| Error::Crypto)?
        .decrypt(
            Nonce::from_slice(&envelope[..12]),
            Payload {
                msg: &envelope[12..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| Error::Crypto)?;
    let record = decode(&plain)?;
    validate(&record, now)?;
    Ok(record)
}

const HISTORY_KEY_DOMAIN: &[u8] = b"ZeroProxy History V2 key\0";
const HISTORY_AAD_DOMAIN: &[u8] = b"ZeroProxy History V2 entry\0";
const HISTORY_FAILURE: &str = "invalid history route";
const HISTORY_MAX_KEY_BYTES: usize = 1024;
const HISTORY_MAX_ENTRY_BYTES: usize = 256;
const HISTORY_MAX_URL_BYTES: usize = 8192;
const HISTORY_NONCE_BYTES: usize = 12;
const HISTORY_TAG_BYTES: usize = 16;
const HISTORY_MAX_ENVELOPE_BYTES: usize =
    HISTORY_NONCE_BYTES + HISTORY_MAX_URL_BYTES + HISTORY_TAG_BYTES;
const HISTORY_MAX_TOKEN_BYTES: usize = (HISTORY_MAX_ENVELOPE_BYTES * 4).div_ceil(3);

fn validate_history_text(value: &str, max_len: usize) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > max_len
        || value.as_bytes().iter().any(|byte| byte.is_ascii_control())
    {
        return Err(());
    }
    Ok(())
}

fn validate_history_target(target_url: &str) -> Result<(), ()> {
    if target_url.is_empty() || target_url.len() > HISTORY_MAX_URL_BYTES {
        return Err(());
    }
    let url = Url::parse(target_url).map_err(|_| ())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(());
    }
    Ok(())
}

fn history_key(key_string: &str) -> Result<[u8; 32], ()> {
    validate_history_text(key_string, HISTORY_MAX_KEY_BYTES)?;
    let mut digest = Sha256::new();
    digest.update(HISTORY_KEY_DOMAIN);
    digest.update((key_string.len() as u32).to_be_bytes());
    digest.update(key_string.as_bytes());
    Ok(digest.finalize().into())
}

fn history_aad(entry_id: &str) -> Result<Vec<u8>, ()> {
    validate_history_text(entry_id, HISTORY_MAX_ENTRY_BYTES)?;
    let mut aad = Vec::with_capacity(HISTORY_AAD_DOMAIN.len() + 4 + entry_id.len());
    aad.extend_from_slice(HISTORY_AAD_DOMAIN);
    aad.extend_from_slice(&(entry_id.len() as u32).to_be_bytes());
    aad.extend_from_slice(entry_id.as_bytes());
    Ok(aad)
}

fn seal_history_with_nonce(
    key_string: &str,
    entry_id: &str,
    target_url: &str,
    nonce: [u8; HISTORY_NONCE_BYTES],
) -> Result<String, ()> {
    validate_history_target(target_url)?;
    let key = history_key(key_string)?;
    let aad = history_aad(entry_id)?;
    let ciphertext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| ())?
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: target_url.as_bytes(),
                aad: &aad,
            },
        )
        .map_err(|_| ())?;
    let mut envelope = Vec::with_capacity(HISTORY_NONCE_BYTES + ciphertext.len());
    envelope.extend_from_slice(&nonce);
    envelope.extend_from_slice(&ciphertext);
    if envelope.len() > HISTORY_MAX_ENVELOPE_BYTES {
        return Err(());
    }
    let token = URL_SAFE_NO_PAD.encode(envelope);
    if token.len() > HISTORY_MAX_TOKEN_BYTES {
        return Err(());
    }
    Ok(token)
}

fn seal_history(key_string: &str, entry_id: &str, target_url: &str) -> Result<String, ()> {
    let mut nonce = [0; HISTORY_NONCE_BYTES];
    rand::rng().fill_bytes(&mut nonce);
    seal_history_with_nonce(key_string, entry_id, target_url, nonce)
}

fn open_history(key_string: &str, entry_id: &str, token: &str) -> Result<String, ()> {
    if token.is_empty() || token.len() > HISTORY_MAX_TOKEN_BYTES {
        return Err(());
    }
    let envelope = URL_SAFE_NO_PAD.decode(token).map_err(|_| ())?;
    if !(HISTORY_NONCE_BYTES + HISTORY_TAG_BYTES..=HISTORY_MAX_ENVELOPE_BYTES)
        .contains(&envelope.len())
    {
        return Err(());
    }
    let key = history_key(key_string)?;
    let aad = history_aad(entry_id)?;
    let plaintext = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| ())?
        .decrypt(
            Nonce::from_slice(&envelope[..HISTORY_NONCE_BYTES]),
            Payload {
                msg: &envelope[HISTORY_NONCE_BYTES..],
                aad: &aad,
            },
        )
        .map_err(|_| ())?;
    if plaintext.len() > HISTORY_MAX_URL_BYTES {
        return Err(());
    }
    let target_url = String::from_utf8(plaintext).map_err(|_| ())?;
    validate_history_target(&target_url)?;
    Ok(target_url)
}

#[wasm_bindgen]
pub fn seal_history_v2(
    key_string: String,
    entry_id: String,
    target_url: String,
) -> Result<String, JsValue> {
    seal_history(&key_string, &entry_id, &target_url)
        .map_err(|_| JsValue::from_str(HISTORY_FAILURE))
}

#[wasm_bindgen]
pub fn open_history_v2(
    key_string: String,
    entry_id: String,
    token: String,
) -> Result<String, JsValue> {
    open_history(&key_string, &entry_id, &token).map_err(|_| JsValue::from_str(HISTORY_FAILURE))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip_and_expiry() {
        let record = Share {
            target_url: "https://example.test/".into(),
            created_at: 1,
            expires_at: Some(3),
            relay_profile_digest: None,
            requested_profile_mode: "ephemeral".into(),
            flags: 0,
        };
        let (path, _) = seal(&record, "https://control.test").unwrap();
        assert_eq!(open(&path, "https://control.test", 2).unwrap(), record);
        assert_eq!(open(&path, "https://control.test", 3), Err(Error::Expired))
    }

    const HISTORY_KEY: &str = "history-secret-material";
    const HISTORY_ENTRY: &str = "entry-id-00000001";
    const HISTORY_URL: &str = "https://example.test/path?query=value#fragment";

    #[test]
    fn history_round_trip_uses_url_safe_no_pad_token() {
        let token = seal_history_with_nonce(
            HISTORY_KEY,
            HISTORY_ENTRY,
            HISTORY_URL,
            [7; HISTORY_NONCE_BYTES],
        )
        .unwrap();
        assert!(
            token
                .bytes()
                .all(|byte| { byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') })
        );
        assert_eq!(
            open_history(HISTORY_KEY, HISTORY_ENTRY, &token).unwrap(),
            HISTORY_URL
        );
    }

    #[test]
    fn history_tampering_and_binding_fail_uniformly() {
        let token = seal_history_with_nonce(
            HISTORY_KEY,
            HISTORY_ENTRY,
            HISTORY_URL,
            [9; HISTORY_NONCE_BYTES],
        )
        .unwrap();
        let mut tampered = URL_SAFE_NO_PAD.decode(&token).unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        let tampered = URL_SAFE_NO_PAD.encode(tampered);

        assert_eq!(open_history(HISTORY_KEY, HISTORY_ENTRY, &tampered), Err(()));
        assert_eq!(
            open_history("another-history-secret", HISTORY_ENTRY, &token),
            Err(())
        );
        assert_eq!(
            open_history(HISTORY_KEY, "entry-id-00000002", &token),
            Err(())
        );
    }

    #[test]
    fn history_rejects_oversize_and_credential_urls() {
        let oversized = format!("https://example.test/{}", "x".repeat(HISTORY_MAX_URL_BYTES));
        assert_eq!(
            seal_history_with_nonce(
                HISTORY_KEY,
                HISTORY_ENTRY,
                &oversized,
                [3; HISTORY_NONCE_BYTES]
            ),
            Err(())
        );
        for target_url in [
            "https://user@example.test/",
            "https://user:password@example.test/",
        ] {
            assert_eq!(
                seal_history_with_nonce(
                    HISTORY_KEY,
                    HISTORY_ENTRY,
                    target_url,
                    [4; HISTORY_NONCE_BYTES]
                ),
                Err(())
            );
        }
    }

    #[test]
    fn history_nonce_is_part_of_the_unique_envelope() {
        let first = seal_history_with_nonce(
            HISTORY_KEY,
            HISTORY_ENTRY,
            HISTORY_URL,
            [1; HISTORY_NONCE_BYTES],
        )
        .unwrap();
        let second = seal_history_with_nonce(
            HISTORY_KEY,
            HISTORY_ENTRY,
            HISTORY_URL,
            [2; HISTORY_NONCE_BYTES],
        )
        .unwrap();
        assert_ne!(first, second);
        let first_envelope = URL_SAFE_NO_PAD.decode(first).unwrap();
        let second_envelope = URL_SAFE_NO_PAD.decode(second).unwrap();
        assert_eq!(
            &first_envelope[..HISTORY_NONCE_BYTES],
            &[1; HISTORY_NONCE_BYTES]
        );
        assert_eq!(
            &second_envelope[..HISTORY_NONCE_BYTES],
            &[2; HISTORY_NONCE_BYTES]
        );
    }

    #[test]
    fn history_sealing_uses_fresh_random_nonces() {
        let first = seal_history(HISTORY_KEY, HISTORY_ENTRY, HISTORY_URL).unwrap();
        let second = seal_history(HISTORY_KEY, HISTORY_ENTRY, HISTORY_URL).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            open_history(HISTORY_KEY, HISTORY_ENTRY, &first).unwrap(),
            HISTORY_URL
        );
        assert_eq!(
            open_history(HISTORY_KEY, HISTORY_ENTRY, &second).unwrap(),
            HISTORY_URL
        );
    }
}
