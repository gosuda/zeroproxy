// Tiny WebSocket echo server for manual ZeroProxy WS bridge verification.
// Run with: go run ./test/fixtures/ws_echo
package main

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

var up = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		log.Printf("ws-echo: connected proto=%q from %s", c.Subprotocol(), r.RemoteAddr)
		defer c.Close()
		for {
			mt, data, err := c.ReadMessage()
			if err != nil {
				log.Printf("ws-echo: read err: %v", err)
				return
			}
			log.Printf("ws-echo: recv mt=%d len=%d", mt, len(data))
			if err := c.WriteMessage(mt, append([]byte("echo:"), data...)); err != nil {
				return
			}
		}
	})
	log.Printf("ws-echo listening on 127.0.0.1:8766")
	log.Fatal(http.ListenAndServe("127.0.0.1:8766", nil))
}
