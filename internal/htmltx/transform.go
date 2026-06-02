package htmltx

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/gosuda/zeroproxy/internal/shareurl"
)

type Options struct {
	TabID                 string
	EntryID               string
	TargetURL             *url.URL
	DocumentCookie        string
	DocumentReferrer      string
	RuntimeToken          string
	Servers               []string
	DynamicCompileAllowed bool
	ReferrerPolicy        string
	DocumentCharset       string
	DocumentRewriter      func(source, targetURL, controlPrefix, runtimePrelude, tabID, runtimeToken string, servers []string) (string, error)
}

var ErrMalformedHTML = errors.New("MALFORMED_HTML")

// Transform rewrites a target HTML stream into a top-level ZeroProxy document.
func Transform(r io.Reader, opt Options) ([]byte, error) {
	var out bytes.Buffer
	if err := TransformTo(&out, r, opt); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// TransformTo delegates document rewriting to the Rust lol_html transform.
func TransformTo(w io.Writer, r io.Reader, opt Options) error {
	if opt.TargetURL == nil || opt.TargetURL.Scheme == "" || opt.TargetURL.Host == "" {
		return fmt.Errorf("%w: missing target URL", ErrMalformedHTML)
	}
	if opt.DocumentRewriter == nil {
		return fmt.Errorf("%w: document rewriter unavailable", ErrMalformedHTML)
	}
	source, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	out, err := opt.DocumentRewriter(
		string(source),
		opt.TargetURL.String(),
		shareurl.ControlPrefix,
		runtimePrelude(opt),
		opt.TabID,
		opt.RuntimeToken,
		opt.Servers,
	)
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, out)
	return err
}

type bootConfig struct {
	TabID                 string   `json:"tabId"`
	EntryID               string   `json:"entryId"`
	TargetURL             string   `json:"targetUrl"`
	DocumentCookie        string   `json:"documentCookie"`
	DocumentReferrer      string   `json:"documentReferrer,omitempty"`
	RuntimeToken          string   `json:"runtimeToken"`
	Servers               []string `json:"servers,omitempty"`
	DynamicCompileAllowed bool     `json:"dynamicCompileAllowed,omitempty"`
	ReferrerPolicy        string   `json:"referrerPolicy,omitempty"`
	DocumentCharset       string   `json:"documentCharset,omitempty"`
}

func runtimePrelude(opt Options) string {
	bootJSON, _ := json.Marshal(bootConfig{
		TabID:                 opt.TabID,
		EntryID:               opt.EntryID,
		TargetURL:             opt.TargetURL.String(),
		DocumentCookie:        opt.DocumentCookie,
		DocumentReferrer:      opt.DocumentReferrer,
		RuntimeToken:          opt.RuntimeToken,
		Servers:               opt.Servers,
		DynamicCompileAllowed: opt.DynamicCompileAllowed,
		ReferrerPolicy:        opt.ReferrerPolicy,
		DocumentCharset:       opt.DocumentCharset,
	})
	var b strings.Builder
	b.Grow(len(bootJSON) + 130)
	b.WriteString(`<script nonce=zp>(function(){const boot=`)
	b.Write(bootJSON)
	b.WriteString(`;Object.defineProperty(window,'__ZP_BOOT',{value:boot,enumerable:false,configurable:true,writable:false});try{document.currentScript.remove()}catch{}})();</script><script nonce=zp src=/zp/assets/runtime-prelude.js></script>`)
	return b.String()
}
