package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gosuda/zeroproxy/internal/testproxy"
)

type stringList []string

func (values *stringList) String() string { return fmt.Sprint([]string(*values)) }
func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func loopbackListenAddress(value string) bool {
	host, _, err := net.SplitHostPort(value)
	if err != nil {
		return false
	}
	address := net.ParseIP(host)
	return address != nil && address.IsLoopback()
}

type options struct {
	listenAddress   string
	eventsPath      string
	readyPath       string
	allowedEndpoint []string
}

type readyRecord struct {
	SchemaVersion int    `json:"schema_version"`
	ProxyURL      string `json:"proxy_url"`
}

func parseOptions(arguments []string) (options, error) {
	flags := flag.NewFlagSet("egress-test-proxy", flag.ContinueOnError)
	listenAddress := flags.String("listen", "127.0.0.1:0", "loopback listen address")
	eventsPath := flags.String("events", "", "new JSONL evidence file")
	readyPath := flags.String("ready", "", "optional new JSON readiness file")
	var allowedEndpoints stringList
	flags.Var(&allowedEndpoints, "allow-endpoint", "exact infrastructure host:port allowed to connect (repeatable)")
	if err := flags.Parse(arguments); err != nil {
		return options{}, err
	}
	if flags.NArg() != 0 || *eventsPath == "" || len(allowedEndpoints) == 0 || !loopbackListenAddress(*listenAddress) {
		return options{}, fmt.Errorf("usage: egress-test-proxy --events <new.jsonl> --allow-endpoint <host:port> [--allow-endpoint <host:port>...] [--listen 127.0.0.1:0] [--ready <new.json>]")
	}
	return options{
		listenAddress: *listenAddress, eventsPath: *eventsPath, readyPath: *readyPath, allowedEndpoint: allowedEndpoints,
	}, nil
}

func writeReady(path string, ready readyRecord) error {
	if path == "" {
		return nil
	}
	bytes, err := json.Marshal(ready)
	if err != nil {
		return err
	}
	return writeExclusive(path, append(bytes, '\n'))
}

func serveUntilSignal(listener net.Listener, recorder *testproxy.Recorder) error {
	server := &http.Server{
		Handler:           recorder,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    32 << 10,
	}
	shutdownContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownContext.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("serve: %w", err)
	}
	return nil
}

func run() error {
	options, err := parseOptions(os.Args[1:])
	if err != nil {
		return err
	}
	events, err := os.OpenFile(options.eventsPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("open event evidence: %w", err)
	}
	defer func() { _ = events.Close() }()
	recorder, err := testproxy.New(options.allowedEndpoint, events)
	if err != nil {
		return err
	}
	defer recorder.CloseIdleConnections()
	listener, err := net.Listen("tcp", options.listenAddress)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer func() { _ = listener.Close() }()
	ready := readyRecord{SchemaVersion: 1, ProxyURL: "http://" + listener.Addr().String()}
	if err := writeReady(options.readyPath, ready); err != nil {
		return fmt.Errorf("write readiness evidence: %w", err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(ready); err != nil {
		return fmt.Errorf("write readiness output: %w", err)
	}
	return serveUntilSignal(listener, recorder)
}

func writeExclusive(path string, bytes []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(bytes); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
