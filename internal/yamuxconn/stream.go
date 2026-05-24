package yamuxconn

// Per-target streams are native net.Conn values returned by Session.OpenStream.
// Keeping stream.go as a tiny seam avoids coupling HTTP, SOCKS, and relay code
// to hashicorp/yamux concrete types.
