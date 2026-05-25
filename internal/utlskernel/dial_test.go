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
			if len(e.AlpnProtocols) != 1 || e.AlpnProtocols[0] != ALPNHTTP1 {
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

func TestChromeSpecAdvertisesH2WhenRequested(t *testing.T) {
	spec, err := chromeSpecForALPN([]string{ALPNHTTP2, ALPNHTTP1})
	if err != nil {
		t.Fatal(err)
	}
	seenALPN := false
	for _, ext := range spec.Extensions {
		switch e := ext.(type) {
		case *utls.ALPNExtension:
			seenALPN = true
			if len(e.AlpnProtocols) != 2 || e.AlpnProtocols[0] != ALPNHTTP2 || e.AlpnProtocols[1] != ALPNHTTP1 {
				t.Fatalf("unexpected ALPN protocols: %#v", e.AlpnProtocols)
			}
		case *utls.ApplicationSettingsExtension:
			if len(e.SupportedProtocols) != 1 || e.SupportedProtocols[0] != ALPNHTTP2 {
				t.Fatalf("unexpected ALPS protocols: %#v", e.SupportedProtocols)
			}
		case *utls.ApplicationSettingsExtensionNew:
			if len(e.SupportedProtocols) != 1 || e.SupportedProtocols[0] != ALPNHTTP2 {
				t.Fatalf("unexpected ALPS protocols: %#v", e.SupportedProtocols)
			}
		}
	}
	if !seenALPN {
		t.Fatal("missing ALPN extension")
	}
}
