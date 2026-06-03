package socks5

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const (
	version5       = 0x05
	methodNoAuth   = 0x00
	methodUserPass = 0x02
	methodNoAccept = 0xff
	cmdConnect     = 0x01
	atypDomainName = 0x03
)

// Options describes a single SOCKS5 CONNECT request. Host must be a domain
// name; IP literals are intentionally rejected so the browser and relay never
// resolve target hostnames outside Tor.
type Options struct {
	Host     string
	Port     string
	Username string
	Password string
}

// ConnectDomain performs RFC 1928 CONNECT using DOMAINNAME ATYP. If Username
// is non-empty, RFC 1929 username/password authentication is offered and the
// username carries the Tor IsolateSOCKSAuth token.
//
// The handshake is driven as an ordered sequence of protocol phases:
// target validation, the method-negotiation greeting (write then read,
// dispatching to username/password auth when the relay selects it), the
// CONNECT request emission, and reply parsing. The deadline plumbing and the
// pre-flight cancellation check are kept inline so SetDeadline's defer fires
// on ConnectDomain's own return and the cancellation gate keeps its exact
// position relative to the greeting.
func ConnectDomain(ctx context.Context, rw io.ReadWriter, opt Options) error {
	host, port, err := resolveTarget(opt)
	if err != nil {
		return err
	}
	if deadline, ok := ctx.Deadline(); ok {
		if c, ok := rw.(interface{ SetDeadline(time.Time) error }); ok {
			_ = c.SetDeadline(deadline)
			defer c.SetDeadline(time.Time{})
		}
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}

	if err := writeGreeting(rw, opt); err != nil {
		return err
	}
	if err := readMethodChoice(ctx, rw, opt); err != nil {
		return err
	}
	if err := writeConnectRequest(rw, host, port); err != nil {
		return err
	}
	if err := readConnectReply(ctx, rw); err != nil {
		return err
	}
	return ctx.Err()
}

// resolveTarget validates and normalizes the CONNECT target. It runs the
// pre-cancellation prologue only (domain normalization/length, IP-literal
// rejection, port parsing); the cancellation gate and any auth-field checks
// remain in ConnectDomain so their ordering is unchanged.
func resolveTarget(opt Options) (string, int, error) {
	host := normalizeDomain(opt.Host)
	if host == "" || len(host) > 255 {
		return "", 0, fmt.Errorf("socks5: invalid domain length")
	}
	if ip := net.ParseIP(host); ip != nil {
		return "", 0, fmt.Errorf("socks5: IP literals are forbidden; DOMAINNAME required")
	}
	port, err := parsePort(opt.Port)
	if err != nil {
		return "", 0, err
	}
	return host, port, nil
}

// writeGreeting emits the method-negotiation greeting. It offers NoAuth and,
// when a username is present, prepends username/password after validating the
// auth field lengths. This runs after the cancellation gate so the
// "auth field too long" error never preempts ctx cancellation.
func writeGreeting(rw io.ReadWriter, opt Options) error {
	methods := []byte{methodNoAuth}
	if opt.Username != "" {
		if len(opt.Username) > 255 || len(opt.Password) > 255 {
			return fmt.Errorf("socks5: auth field too long")
		}
		methods = append([]byte{methodUserPass}, methods...)
	}
	if _, err := rw.Write(append([]byte{version5, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	return nil
}

// readMethodChoice reads the relay's method selection, gates on the version
// byte, rejects "no acceptable method", and runs username/password auth when
// selected. Any other non-NoAuth selection is rejected as unsupported.
func readMethodChoice(ctx context.Context, rw io.ReadWriter, opt Options) error {
	var choice [2]byte
	if _, err := io.ReadFull(ctxReader{ctx: ctx, r: rw}, choice[:]); err != nil {
		return err
	}
	if choice[0] != version5 {
		return fmt.Errorf("socks5: unexpected version %d", choice[0])
	}
	if choice[1] == methodNoAccept {
		return errors.New("socks5: no acceptable auth method")
	}
	if choice[1] == methodUserPass {
		if err := authUserPass(ctx, rw, opt.Username, opt.Password); err != nil {
			return err
		}
	} else if choice[1] != methodNoAuth {
		return fmt.Errorf("socks5: unsupported auth method %d", choice[1])
	}
	return nil
}

// writeConnectRequest emits the RFC 1928 CONNECT request with DOMAINNAME ATYP.
func writeConnectRequest(rw io.ReadWriter, host string, port int) error {
	req := make([]byte, 0, 7+len(host))
	req = append(req, version5, cmdConnect, 0x00, atypDomainName, byte(len(host)))
	req = append(req, host...)
	var p [2]byte
	binary.BigEndian.PutUint16(p[:], uint16(port))
	req = append(req, p[:]...)
	if _, err := rw.Write(req); err != nil {
		return err
	}
	return nil
}

// readConnectReply parses the CONNECT reply: version byte, reply code,
// reserved byte, then discards the bound address per its ATYP. It returns the
// bound-address consumption error directly; ConnectDomain follows a successful
// reply with ctx.Err() so a late cancellation still surfaces.
func readConnectReply(ctx context.Context, rw io.ReadWriter) error {
	var hdr [4]byte
	if _, err := io.ReadFull(ctxReader{ctx: ctx, r: rw}, hdr[:]); err != nil {
		return err
	}
	if hdr[0] != version5 {
		return fmt.Errorf("socks5: unexpected reply version %d", hdr[0])
	}
	if hdr[1] != 0x00 {
		return fmt.Errorf("socks5: connect failed with reply 0x%02x", hdr[1])
	}
	if hdr[2] != 0x00 {
		return errors.New("socks5: invalid reserved byte")
	}
	return discardBindAddress(ctx, rw, hdr[3])
}

func authUserPass(ctx context.Context, rw io.ReadWriter, username, password string) error {
	buf := make([]byte, 0, 3+len(username)+len(password))
	buf = append(buf, 0x01, byte(len(username)))
	buf = append(buf, username...)
	buf = append(buf, byte(len(password)))
	buf = append(buf, password...)
	if _, err := rw.Write(buf); err != nil {
		return err
	}
	var resp [2]byte
	if _, err := io.ReadFull(ctxReader{ctx: ctx, r: rw}, resp[:]); err != nil {
		return err
	}
	if resp[0] != 0x01 || resp[1] != 0x00 {
		return errors.New("socks5: username/password auth failed")
	}
	return nil
}

func discardBindAddress(ctx context.Context, rw io.ReadWriter, atyp byte) error {
	var n int
	switch atyp {
	case 0x01:
		n = 4 + 2
	case atypDomainName:
		var l [1]byte
		if _, err := io.ReadFull(ctxReader{ctx: ctx, r: rw}, l[:]); err != nil {
			return err
		}
		n = int(l[0]) + 2
	case 0x04:
		n = 16 + 2
	default:
		return fmt.Errorf("socks5: unknown reply address type %d", atyp)
	}
	_, err := io.CopyN(io.Discard, ctxReader{ctx: ctx, r: rw}, int64(n))
	return err
}

func normalizeDomain(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	host = strings.TrimSuffix(host, ".")
	return host
}

func parsePort(s string) (int, error) {
	if s == "" {
		return 0, fmt.Errorf("socks5: missing port")
	}
	var p uint64
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return 0, fmt.Errorf("socks5: invalid port %q", s)
		}
		p = p*10 + uint64(s[i]-'0')
		if p > 65535 {
			return 0, fmt.Errorf("socks5: port out of range")
		}
	}
	if p == 0 {
		return 0, fmt.Errorf("socks5: port out of range")
	}
	return int(p), nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (r ctxReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.r.Read(p)
	}
}
