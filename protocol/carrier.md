# ZeroProxy Carrier V2

`protocol/carrier.schema.json`, this document, and `protocol/carrier.fixtures.json` are the carrier-handshake wire authority. `protocol/messages.schema.json` governs coordinator envelopes only and does not apply here.

## Admission

The WebSocket subprotocol is the literal `zeroproxy.carrier.v2`. The relay accepts a carrier only on the configured carrier path, with an exact allowed browsing `Origin`, and with that subprotocol negotiated. Capability material is never read from the request target, query, cookies, or `Authorization`.

Every handshake message is one complete WebSocket binary message containing one deterministic, canonical CBOR map. Text messages, fragmented application records, noncanonical encodings, duplicate or unknown map keys, tags, indefinite-length values, and frames larger than 4096 bytes are protocol violations. No smux or application byte may be written or accepted before `SERVER_ACCEPT` has been sent and verified.

The JSON Schema describes diagnostic field names. Those names are not sent. Each property’s `x-cbor-key` is its unsigned integer map key; fixed-length hexadecimal strings in JSON are CBOR byte strings on the wire. Unsigned integers use their shortest CBOR representation. Maps use RFC 8949 deterministic key ordering.

## Frames

### CLIENT_INIT

| Key | Diagnostic field | CBOR type | Constraint |
| --- | --- | --- | --- |
| 1 | `capability_id` | text | 1–256 UTF-8 bytes |
| 2 | `versions` | array of uint16 | 1–8 unique offers; V2 is integer `2` |
| 3 | `feature_bits` | uint64 | offered feature bitset |
| 4 | `client_nonce` | bytes | exactly 32 nonzero random bytes |

### SERVER_CHALLENGE

| Key | Diagnostic field | CBOR type | Constraint |
| --- | --- | --- | --- |
| 1 | `server_nonce` | bytes | exactly 32 random bytes |
| 2 | `selected_version` | uint16 | exactly `2` and present in the offer |
| 3 | `selected_features` | uint64 | subset of offered and capability-authorized features |
| 4 | `selected_limits` | map | exact `Limits` map below |
| 5 | `capability_claims_digest` | bytes | exactly 32 bytes |
| 6 | `challenge_id` | bytes | exactly 24 random bytes |

### CLIENT_AUTH

| Key | Diagnostic field | CBOR type | Constraint |
| --- | --- | --- | --- |
| 1 | `challenge_id` | bytes | exactly the challenged 24-byte ID |
| 2 | `proof` | bytes | `HMAC-SHA256(auth_key, canonical_transcript_hash)` |

### SERVER_ACCEPT

| Key | Diagnostic field | CBOR type | Constraint |
| --- | --- | --- | --- |
| 1 | `carrier_id` | bytes | exactly 24 random bytes |
| 2 | `negotiated_limits` | map | byte-for-byte logical equality with selected limits |
| 3 | `capability_epoch` | uint64 | nonzero challenged capability epoch |
| 4 | `server_proof` | bytes | `HMAC-SHA256(auth_key, "server" || canonical_transcript_hash)` |

### Limits

| Key | Diagnostic field | CBOR type | Constraint |
| --- | --- | --- | --- |
| 1 | `max_streams` | uint32 | 1–4096 |
| 2 | `upload_byte_budget` | uint64 | positive browser-to-relay budget |
| 3 | `download_byte_budget` | uint64 | positive relay-to-browser budget |
| 4 | `max_frame_bytes` | uint32 | 1–65536 |
| 5 | `max_message_bytes` | uint32 | `max_frame_bytes`–4194304 |
| 6 | `max_frames_per_second` | uint32 | 1–10000 |
| 7 | `handshake_timeout_ms` | uint32 | 1000–60000 |
| 8 | `idle_timeout_ms` | uint32 | 1000–3600000 |
| 9 | `session_deadline_ms` | uint32 | `idle_timeout_ms`–86400000 |

## Capability claims and replay

The challenged `capability_claims_digest` is SHA-256 of the canonical-CBOR claims map. The relay stores that claims map and its 32-byte verifier key; it never stores the capability secret. Claims keys are: `1 capability_id`, `2 deployment_id`, `3 session_binding_digest`, `4 capability_epoch`, `5 relay_profile_digest`, `6 expires_unix`, `7 allowed_browsing_origins`, `8 max_sessions`, `9 limits`, and `10 feature_bits`. `session_binding_digest` is HMAC-derived for the exact deployment, capability, and sorted browsing-origin grammar. The client compares the challenged digest with its issued digest before sending `CLIENT_AUTH`.

`auth_key = HKDF-SHA256(capability_secret, deployment_salt, "zeroproxy-carrier-v2")`; the stored verifier is that same derived 32-byte key. A durable replay row contains the exact `{capability_id, capability_epoch, client_nonce, challenge_id, expires_at}` tuple and remains until expiry even after reservation release. Missing or corrupt durable replay storage fails relay startup. A challenge owns one internal reservation; bad proof, timeout, disconnect, expiry, rotation, and accepted-carrier close release it exactly once without deleting its replay row.

Upload means browser-to-relay and download means relay-to-browser. Handshake and application bytes count against their respective negotiated budgets. Exhaustion closes the carrier and never rolls over or borrows from the opposite direction.

## Transcript

Let `I` be the exact canonical-CBOR bytes of `CLIENT_INIT` and `C` the exact canonical-CBOR bytes of `SERVER_CHALLENGE`. The transcript hash is:

```text
SHA-256(uint32be(len(I)) || I || uint32be(len(C)) || C)
```

This commits both nonces, every offered version and feature, every selection and limit, the capability claims digest, and the challenge ID. Implementations must compute proofs over the received canonical bytes represented by those logical values. Proof comparison is constant time.

## State machine

```text
NEW --CLIENT_INIT--> CHALLENGED --matching CLIENT_AUTH before deadline--> ACCEPTED
  \                     \                                              \
   +--anything else------> CLOSED                                       +--disconnect/expiry--> CLOSED
                         +--unknown/duplicate/replay/late/bad proof------> CLOSED
```

`NEW` accepts exactly one `CLIENT_INIT`. `CHALLENGED` emits exactly one `SERVER_CHALLENGE` and accepts exactly one matching `CLIENT_AUTH` before the handshake deadline. A successful proof causes exactly one `SERVER_ACCEPT`; only after it is written may either peer create smux/application traffic. Unknown, duplicate, replayed, out-of-order, oversized, late, text, or disconnected state/frame pairs close the carrier. Closed state is terminal.

`protocol/carrier.fixtures.json` contains the canonical bytes, transcript hash, and both proofs for the four-frame known-answer exchange. Production codecs must match every fixture byte-for-byte.
