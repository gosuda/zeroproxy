//! X25519MLKEM768 hybrid TLS 1.3 key exchange (NamedGroup 0x11ec = 4588).
//!
//! Wire spec: [draft-kwiatkowski-tls-ecdhe-mlkem-04] §3 ("Hybrid Key Share").
//! Chrome 148 advertises this group on every ClientHello and the
//! corresponding entry in `key_share`; emitting it on our end closes the
//! last JA3 curves-component divergence between ZP and a real Chrome.
//!
//! ## Wire layout
//!
//! Client `KeyShareEntry.key_exchange` (for group 0x11ec):
//! ```text
//!   bytes  0..1184  ML-KEM-768 EncapsulationKey  (1184 bytes)
//!   bytes 1184..1216 X25519 public key            (  32 bytes)
//!   total: 1216 bytes
//! ```
//!
//! Server share:
//! ```text
//!   bytes  0..1088  ML-KEM-768 Ciphertext        (1088 bytes)
//!   bytes 1088..1120 X25519 public key            (  32 bytes)
//!   total: 1120 bytes
//! ```
//!
//! Final shared secret fed into the TLS 1.3 key schedule:
//! ```text
//!   ML-KEM-768 shared secret (32 bytes)  ||  X25519 shared secret (32 bytes)
//! ```

extern crate alloc;
use alloc::boxed::Box;
use alloc::vec::Vec;

use ml_kem::kem::{Decapsulate, Kem};
use ml_kem::{Ciphertext, DecapsulationKey, KeyExport, MlKem768};
use rustls::crypto::{ActiveKeyExchange, SharedSecret, SupportedKxGroup};
use rustls::{Error, NamedGroup, PeerMisbehaved};

const MLKEM768_CT_LEN: usize = 1088;
const MLKEM768_EK_LEN: usize = 1184;
const X25519_LEN: usize = 32;

const CLIENT_SHARE_LEN: usize = MLKEM768_EK_LEN + X25519_LEN;
const SERVER_SHARE_LEN: usize = MLKEM768_CT_LEN + X25519_LEN;

#[derive(Debug)]
pub struct X25519MLKEM768;

impl SupportedKxGroup for X25519MLKEM768 {
    fn name(&self) -> NamedGroup {
        NamedGroup::X25519MLKEM768
    }

    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let (mlkem_dk, mlkem_ek) = MlKem768::generate_keypair();
        let x25519_priv =
            x25519_dalek::EphemeralSecret::random_from_rng(&mut rand_core::OsRng);
        let x25519_pub: x25519_dalek::PublicKey = (&x25519_priv).into();

        let mut pub_share = Vec::with_capacity(CLIENT_SHARE_LEN);
        // Draft-kwiatkowski-tls-ecdhe-mlkem (group 0x11ec) order under
        // active discussion across browsers — Chrome 148 / BoringSSL
        // emit `MLKEM_EK || X25519_pub` in their actual ClientHello
        // (matched against captured wire on tls.peet.ws). The earlier
        // attempt with `X25519 || MLKEM` (Kyber-draft-00 style)
        // triggered server-side `IllegalParameter` alert from tls.peet.ws,
        // so this implementation pins MLKEM-first.
        let ek_bytes = mlkem_ek.to_bytes();
        pub_share.extend_from_slice(ek_bytes.as_slice());
        pub_share.extend_from_slice(x25519_pub.as_bytes());
        debug_assert_eq!(pub_share.len(), CLIENT_SHARE_LEN);

        Ok(Box::new(Active {
            mlkem_dk,
            x25519_priv,
            pub_share,
        }))
    }
}

struct Active {
    mlkem_dk: DecapsulationKey<MlKem768>,
    x25519_priv: x25519_dalek::EphemeralSecret,
    pub_share: Vec<u8>,
}

impl ActiveKeyExchange for Active {
    fn complete(self: Box<Self>, peer: &[u8]) -> Result<SharedSecret, Error> {
        if peer.len() != SERVER_SHARE_LEN {
            return Err(Error::from(PeerMisbehaved::InvalidKeyShare));
        }
        let (mlkem_ct_bytes, x25519_pub_bytes) = peer.split_at(MLKEM768_CT_LEN);

        // ML-KEM half. Reconstruct the `Ciphertext` (a size-typed
        // `Array`) from the 1088-byte wire slice. ml-kem 0.3's
        // `Decapsulate::decapsulate` is infallible (`Error = Infallible`)
        // and returns the `SharedKey` directly.
        let mut ct_arr = Ciphertext::<MlKem768>::default();
        ct_arr.as_mut_slice().copy_from_slice(mlkem_ct_bytes);
        let mlkem_ss = self.mlkem_dk.decapsulate(&ct_arr);

        // X25519 half.
        let x25519_pub_array: [u8; X25519_LEN] = x25519_pub_bytes
            .try_into()
            .map_err(|_| Error::from(PeerMisbehaved::InvalidKeyShare))?;
        let x25519_ss = self
            .x25519_priv
            .diffie_hellman(&x25519_pub_array.into());

        // Hybrid shared secret: ML-KEM first, then X25519 (draft §3,
        // matches aws_lc_rs `Layout { post_quantum_first: true }` in
        // rustls 0.23's PQ module).
        let mut ss = Vec::with_capacity(64);
        ss.extend_from_slice(mlkem_ss.as_slice());
        ss.extend_from_slice(x25519_ss.as_bytes());
        Ok(SharedSecret::from(ss.as_slice()))
    }

    fn pub_key(&self) -> &[u8] {
        &self.pub_share
    }

    fn group(&self) -> NamedGroup {
        X25519MLKEM768.name()
    }

    /// Advertise the classical X25519 sibling as a "free" extra
    /// key_share entry. Chrome 148 sends both: `X25519MLKEM768` (1216 B)
    /// AND `X25519` (32 B) in the same ClientHello so a server that
    /// doesn't support the hybrid can pick the classical without
    /// triggering a HelloRetryRequest round-trip. The classical share is
    /// the trailing 32 bytes of `pub_share` (FIPS 203 `EK || X25519_pub`
    /// layout — `post_quantum_first = true` per the draft and aws_lc_rs).
    fn hybrid_component(&self) -> Option<(NamedGroup, &[u8])> {
        let x25519_pub = &self.pub_share[MLKEM768_EK_LEN..];
        debug_assert_eq!(x25519_pub.len(), X25519_LEN);
        Some((NamedGroup::X25519, x25519_pub))
    }

    /// Called instead of `complete()` when the server picked our
    /// classical X25519 sibling (not the hybrid). Drops the ML-KEM
    /// decapsulation key and runs X25519 standalone.
    fn complete_hybrid_component(
        self: Box<Self>,
        peer_pub_key: &[u8],
    ) -> Result<SharedSecret, Error> {
        if peer_pub_key.len() != X25519_LEN {
            return Err(Error::from(PeerMisbehaved::InvalidKeyShare));
        }
        let x25519_pub_array: [u8; X25519_LEN] = peer_pub_key
            .try_into()
            .map_err(|_| Error::from(PeerMisbehaved::InvalidKeyShare))?;
        let x25519_ss = self
            .x25519_priv
            .diffie_hellman(&x25519_pub_array.into());
        Ok(SharedSecret::from(x25519_ss.as_bytes().as_slice()))
    }
}

// Host-native unit tests are not feasible: this crate is gated
// `#![cfg(target_arch = "wasm32")]` at `lib.rs:7`. Verification of the
// 1216-byte wire share happens live against `tls.peet.ws` (JA3 curves
// tuple) and via real-site regression (Wikipedia / NAVER / GitHub).
