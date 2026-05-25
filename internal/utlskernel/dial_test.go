package utlskernel

import (
	"testing"

	utls "github.com/refraction-networking/utls"
)

func TestHTTP1OnlyChromeSpecDoesNotAdvertiseH2(t *testing.T) {
	spec, err := http1OnlyChromeSpec()
	if err != nil {
		t.Fatal(err)
	}
	seenALPN := false
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			seenALPN = true
			if len(e.AlpnProtocols) != 1 || e.AlpnProtocols[0] != "http/1.1" {
				t.Fatalf("unexpected ALPN protocols: %#v", e.AlpnProtocols)
			}
		case *utls.ApplicationSettingsExtension:
			t.Fatalf("ALPS extension advertises protocols without HTTP/2 support: %#v", e.SupportedProtocols)
		case *utls.ApplicationSettingsExtensionNew:
			t.Fatalf("ALPS extension advertises protocols without HTTP/2 support: %#v", e.SupportedProtocols)
		}
	}
	if !seenALPN {
		t.Fatal("missing ALPN extension")
	}
}
