// klap-realtime is the chatb.org room relay (https://r-w-x.org/r/chatb.git)
// running as a sidecar to the Django app. It carries WebRTC signalling,
// live drafts and ascii frames between the people in an assembly. It keeps
// nothing on disk: rooms exist only while someone is connected.
package main

import (
	"flag"
	"log"
	"net/http"

	"golang.org/x/net/websocket"

	"klap/realtime/rooms"
)

var listenAddr = flag.String("http", ":8001", "listen on this http address")

var certFile = flag.String("cert", "",
	"TLS certificate, if cert and key are provided server will use tls")

var keyFile = flag.String("key", "",
	"TLS key, if cert and key are provided server will use tls")

func main() {
	flag.Parse()

	// websocket.Server instead of websocket.Handler: the page and the relay
	// live on different ports in development, so the default same-origin
	// handshake check would refuse every connection.
	http.Handle("/_rooms", websocket.Server{Handler: rooms.Handler})
	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok\n"))
	})

	log.Println("klap-realtime listening on", *listenAddr)
	var err error
	if *certFile != "" && *keyFile != "" {
		err = http.ListenAndServeTLS(*listenAddr, *certFile, *keyFile, nil)
	} else {
		err = http.ListenAndServe(*listenAddr, nil)
	}
	if err != nil {
		log.Fatalf("http.ListenAndServe: %v", err)
	}
}
