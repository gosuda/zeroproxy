package socks5

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

type scriptedRW struct {
	in  bytes.Buffer
	out bytes.Buffer
}

func (s *scriptedRW) Read(p []byte) (int, error)  { return s.in.Read(p) }
func (s *scriptedRW) Write(p []byte) (int, error) { return s.out.Write(p) }

func TestConnectDomainUsesAuthAndDomainATYP(t *testing.T) {
	rw := &scriptedRW{}
	rw.in.Write([]byte{0x05, 0x02})
	rw.in.Write([]byte{0x01, 0x00})
	rw.in.Write([]byte{0x05, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00})
	if err := ConnectDomain(context.Background(), rw, Options{Host: "Example.COM", Port: "443", Username: "token", Password: "zp"}); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(&rw.out)
	wantPrefix := []byte{0x05, 0x02, 0x02, 0x00, 0x01, 0x05, 't', 'o', 'k', 'e', 'n', 0x02, 'z', 'p', 0x05, 0x01, 0x00, 0x03, 0x0b}
	if !bytes.HasPrefix(got, wantPrefix) {
		t.Fatalf("handshake prefix mismatch: %v", got)
	}
	if !bytes.Contains(got, []byte("example.com")) {
		t.Fatalf("domain was not normalized/preserved as domain: %v", got)
	}
}

func TestConnectDomainRejectsIPLiteral(t *testing.T) {
	if err := ConnectDomain(context.Background(), &scriptedRW{}, Options{Host: "93.184.216.34", Port: "80"}); err == nil {
		t.Fatal("expected IP literal rejection")
	}
}

// testHost is a domain whose lowercased bytes ("example.com") appear ONLY in
// the SOCKS5 CONNECT request body. Its presence/absence in the bytes written to
// the relay is therefore a direct witness of whether the handshake advanced to
// the CONNECT stage.
const testHost = "example.com"

// validCONNECTReply is a well-formed, successful CONNECT reply with a 4-byte
// IPv4 BIND address (ATYP 0x01): VER, REP=0x00 (succeeded), RSV=0x00,
// ATYP=0x01, then 4+2 bytes of address+port. Appended after a single hostile
// field so that NEUTRALIZING the guard under test makes ConnectDomain consume
// this remainder and return nil — i.e. the real "would tunnel" condition. This
// is what makes the mutation flip err -> nil (RED for the right reason) instead
// of merely changing the error via a downstream EOF.
var validCONNECTReply = []byte{0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00}

// fail-closed adversarial table: each case feeds the REAL handshake/parse code
// a hostile or garbled relay reply and asserts (a) the SPECIFIC error and
// (b) that the proxy does NOT proceed to tunnel. ConnectDomain never tunnels
// itself — its caller tunnels iff it returns nil — so (b) is: a non-nil error
// is returned. For cases that fail BEFORE the CONNECT request is written, we
// additionally assert the host bytes never reached the relay, an independent
// witness that the handshake never advanced.
func TestConnectDomainFailsClosedOnHostileReply(t *testing.T) {
	tests := []struct {
		name string
		// script is the sequence of bytes the relay "sends" back. It contains
		// exactly one hostile field followed (where meaningful) by an otherwise
		// valid remainder, so removing the guard would let ConnectDomain reach
		// a nil return.
		script []byte
		// auth requests username/password auth so the auth-failed reply is
		// reachable; otherwise NoAuth is negotiated.
		auth bool
		// wantErr is a substring of the SPECIFIC error message produced by the
		// guard under test (the package uses fmt.Errorf/errors.New, no exported
		// sentinels — substring match on the real message is the correct check).
		wantErr string
		// preCONNECT is true when the guard fires before the CONNECT request is
		// written. For those cases the host bytes must be absent from output.
		preCONNECT bool
	}{
		{
			// client.go:76-77 — method-selection reply version != 0x05.
			name:       "method reply version not 0x05",
			script:     append([]byte{0x04, 0x00}, validCONNECTReply...),
			wantErr:    "unexpected version",
			preCONNECT: true,
		},
		{
			// client.go:79-81 — server selects 0xff "no acceptable method".
			name:       "no acceptable auth method",
			script:     append([]byte{0x05, 0xff}, validCONNECTReply...),
			wantErr:    "no acceptable auth method",
			preCONNECT: true,
		},
		{
			// client.go:86-88 — server selects an auth method the client never
			// offered (0x03), which is neither NoAuth nor UserPass.
			name:       "unsupported auth method selected",
			script:     append([]byte{0x05, 0x03}, validCONNECTReply...),
			wantErr:    "unsupported auth method",
			preCONNECT: true,
		},
		{
			// client.go:131-132 — username/password auth reply with a nonzero
			// status byte (auth rejected). Remainder is a valid CONNECT reply so
			// deleting the guard would let the handshake complete and return nil.
			name:       "username/password auth failed",
			auth:       true,
			script:     append([]byte{0x05, 0x02, 0x01, 0x01}, validCONNECTReply...),
			wantErr:    "username/password auth failed",
			preCONNECT: true,
		},
		{
			// client.go:106-107 — CONNECT reply with nonzero REP code
			// (0x05 = host unreachable). Fires after the CONNECT write.
			// Leading {0x05,0x00} is the NoAuth method-selection reply; the
			// remaining bytes are the CONNECT reply header + IPv4 BIND addr.
			name:    "connect reply nonzero code host unreachable",
			script:  []byte{0x05, 0x00, 0x05, 0x05, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
			wantErr: "connect failed with reply 0x05",
		},
		{
			// client.go:109-111 — CONNECT reply with nonzero reserved byte.
			// Leading {0x05,0x00} is the method-selection reply; then a CONNECT
			// header VER=0x05, REP=0x00, RSV=0x01 (hostile), ATYP=0x01.
			name:    "connect reply nonzero reserved byte",
			script:  []byte{0x05, 0x00, 0x05, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
			wantErr: "invalid reserved byte",
		},
		{
			// client.go:150-151 — unknown reply ATYP in discardBindAddress.
			// Leading {0x05,0x00} is the method-selection reply; then a CONNECT
			// header VER=0x05, REP=0x00, RSV=0x00, ATYP=0x02 (not 0x01/0x03/0x04).
			name:    "unknown reply address type",
			script:  []byte{0x05, 0x00, 0x05, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00},
			wantErr: "unknown reply address type",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rw := &scriptedRW{}
			rw.in.Write(tt.script)

			opt := Options{Host: "Example.COM", Port: "443"}
			if tt.auth {
				opt.Username = "token"
				opt.Password = "zp"
			}

			err := ConnectDomain(context.Background(), rw, opt)

			// (b) fail-closed: malformed reply MUST yield a non-nil error, since
			// the caller tunnels iff ConnectDomain returns nil.
			if err == nil {
				t.Fatalf("%s: expected fail-closed error, got nil (would tunnel)", tt.name)
			}
			// (a) the SPECIFIC guard fired.
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("%s: error = %q, want substring %q", tt.name, err.Error(), tt.wantErr)
			}

			// Independent fail-closed witness for guards that fire before the
			// CONNECT request is written: the target host must never have been
			// sent to the relay.
			if tt.preCONNECT {
				out := rw.out.Bytes()
				if bytes.Contains(out, []byte(testHost)) {
					t.Fatalf("%s: host %q leaked to relay before handshake completed: %v", tt.name, testHost, out)
				}
			}
		})
	}
}
