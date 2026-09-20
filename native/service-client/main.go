package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const (
	maxPorts    = 8
	maxFlows    = 32
	maxLease    = 5 * time.Minute
	drainWindow = 5 * time.Second
)

var errClosed = errors.New("service access unavailable")

type serviceMapping struct {
	Local  uint16 `json:"local"`
	Remote uint16 `json:"remote"`
}

type serviceFlow struct {
	local net.Conn
	tail  net.Conn
}

func strictJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return errClosed
	}
	return nil
}

func bindMappings(mappings []serviceMapping) ([]net.Listener, error) {
	if len(mappings) == 0 || len(mappings) > maxPorts {
		return nil, errClosed
	}
	listeners := make([]net.Listener, 0, len(mappings))
	local, remote := map[uint16]bool{}, map[uint16]bool{}
	for _, mapping := range mappings {
		if mapping.Local == 0 || mapping.Remote == 0 || local[mapping.Local] || remote[mapping.Remote] {
			for _, listener := range listeners {
				_ = listener.Close()
			}
			return nil, errClosed
		}
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(mapping.Local))))
		if err != nil {
			for _, opened := range listeners {
				_ = opened.Close()
			}
			return nil, errClosed
		}
		listeners = append(listeners, listener)
		local[mapping.Local], remote[mapping.Remote] = true, true
	}
	return listeners, nil
}

func forward(ctx context.Context, client *tailcat.Client, mappings []serviceMapping, listeners []net.Listener) error {
	defer client.Close()
	var mu sync.Mutex
	var workers sync.WaitGroup
	flows := map[*serviceFlow]bool{}
	closing := false
	closeFlow := func(flow *serviceFlow) {
		if flow.local != nil {
			_ = flow.local.Close()
		}
		if flow.tail != nil {
			_ = flow.tail.Close()
		}
	}
	for index, listener := range listeners {
		workers.Add(1)
		go func(listener net.Listener, port uint16) {
			defer workers.Done()
			for {
				local, err := listener.Accept()
				if err != nil {
					return
				}
				flow := &serviceFlow{local: local}
				mu.Lock()
				if closing || ctx.Err() != nil || len(flows) >= maxFlows {
					mu.Unlock()
					_ = local.Close()
					continue
				}
				flows[flow] = true
				workers.Add(1)
				mu.Unlock()
				go func() {
					defer workers.Done()
					defer func() { mu.Lock(); closeFlow(flow); delete(flows, flow); mu.Unlock() }()
					remote, err := client.DialTCPPort(ctx, port)
					if err != nil {
						return
					}
					mu.Lock()
					if closing || ctx.Err() != nil {
						mu.Unlock()
						_ = remote.Close()
						return
					}
					flow.tail = remote
					mu.Unlock()
					done := make(chan struct{})
					go func() {
						_, _ = io.Copy(remote, local)
						if writer, ok := remote.(interface{ CloseWrite() error }); ok {
							_ = writer.CloseWrite()
						}
						close(done)
					}()
					_, _ = io.Copy(local, remote)
					if writer, ok := local.(interface{ CloseWrite() error }); ok {
						_ = writer.CloseWrite()
					}
					<-done
				}()
			}
		}(listener, mappings[index].Remote)
	}
	<-ctx.Done()
	mu.Lock()
	closing = true
	for _, listener := range listeners {
		_ = listener.Close()
	}
	for flow := range flows {
		closeFlow(flow)
	}
	mu.Unlock()
	done := make(chan struct{})
	go func() { workers.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-time.After(drainWindow):
		return errClosed
	}
}

func runServiceClient(ctx context.Context, input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	lines := make(chan []byte)
	go func() {
		defer close(lines)
		scanner := bufio.NewScanner(input)
		scanner.Buffer(make([]byte, 4_096), 16_384)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
	}()
	read := func() ([]byte, error) {
		select {
		case line, ok := <-lines:
			if !ok {
				return nil, errClosed
			}
			return line, nil
		case <-ctx.Done():
			return nil, errClosed
		case <-time.After(50 * time.Second):
			return nil, errClosed
		}
	}
	var init struct {
		Mappings []serviceMapping `json:"mappings"`
	}
	raw, err := read()
	if err != nil || strictJSON(raw, &init) != nil {
		return errClosed
	}
	listeners, err := bindMappings(init.Mappings)
	if err != nil {
		return errClosed
	}
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	private := key.NewNode()
	if json.NewEncoder(output).Encode(map[string]string{"client_key": private.Public().String()}) != nil {
		return errClosed
	}
	var config struct {
		Address tailcat.Addr `json:"address"`
		Expires int64        `json:"expires_at"`
	}
	raw, err = read()
	if err != nil || strictJSON(raw, &config) != nil || config.Address == "" || len(config.Address) > 4_096 {
		return errClosed
	}
	now := time.Now()
	deadline := time.Unix(config.Expires, 0)
	if !deadline.After(now) || deadline.After(now.Add(maxLease)) {
		return errClosed
	}
	lease, stop := context.WithDeadline(ctx, deadline)
	defer stop()
	go func() {
		select {
		case <-lines:
			stop()
		case <-lease.Done():
		}
	}()
	client := &tailcat.Client{Server: config.Address, Key: private, Logf: logger.Discard}
	if json.NewEncoder(output).Encode(map[string]bool{"ready": true}) != nil {
		return errClosed
	}
	return forward(lease, client, init.Mappings, listeners)
}

func main() {
	if os.Getenv("TS_DEBUG_ADDR") != "" || len(os.Args) != 2 || os.Args[1] != "service-client" {
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	if runServiceClient(ctx, os.Stdin, os.Stdout) != nil {
		os.Exit(1)
	}
}
