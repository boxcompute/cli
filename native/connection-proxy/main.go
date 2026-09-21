// boxcompute-proxy carries one short-lived SSH byte stream over Tailcat.
// The admission, endpoint creation, and lease authority remain server-side.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/tailscale/tailcat"
	"tailscale.com/types/key"
	"tailscale.com/types/logger"
)

const maxLease = 5 * time.Minute

var errClosed = errors.New("connection proxy unavailable")

type config struct {
	Key       key.NodePrivate `json:"key"`
	Address   tailcat.Addr    `json:"address"`
	ExpiresAt time.Time       `json:"expires_at"`
}

func readConfig(path string) (config, [32]byte, error) {
	var cfg config
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return cfg, [32]byte{}, errClosed
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 64<<10 {
		return cfg, [32]byte{}, errClosed
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return cfg, [32]byte{}, errClosed
	}
	data, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
	if err != nil || len(data) > 64<<10 || json.Unmarshal(data, &cfg) != nil {
		return cfg, [32]byte{}, errClosed
	}
	if cfg.Key.IsZero() || cfg.Address == "" || time.Until(cfg.ExpiresAt) <= 0 || time.Until(cfg.ExpiresAt) > maxLease {
		return cfg, [32]byte{}, errClosed
	}
	return cfg, sha256.Sum256(data), nil
}

func watchLease(ctx context.Context, cancel context.CancelFunc, path string, digest [32]byte) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, current, err := readConfig(path)
			if err != nil || current != digest {
				cancel()
				return
			}
		}
	}
}

func proxy(ctx context.Context, cfg config, input io.Reader, output io.Writer) error {
	client := &tailcat.Client{Server: cfg.Address, Key: cfg.Key, Logf: logger.Discard}
	defer client.Close()
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	connection, err := client.DialTCPPort(dialCtx, 22)
	cancel()
	if err != nil {
		return errClosed
	}
	defer connection.Close()
	stop := context.AfterFunc(ctx, func() {
		connection.Close()
		if closer, ok := input.(io.Closer); ok {
			closer.Close()
		}
		if closer, ok := output.(io.Closer); ok {
			closer.Close()
		}
	})
	defer stop()
	go func() {
		_, _ = io.Copy(connection, input)
		if writer, ok := connection.(interface{ CloseWrite() error }); ok {
			_ = writer.CloseWrite()
		} else {
			connection.Close()
		}
	}()
	_, err = io.Copy(output, connection)
	return err
}

func keygen(path string, output io.Writer) error {
	directory, err := os.OpenRoot(filepath.Dir(path))
	if err != nil {
		return errClosed
	}
	defer directory.Close()
	info, err := directory.Stat(".")
	if err != nil || info.Mode().Perm() != 0700 {
		return errClosed
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return errClosed
	}
	private := key.NewNode()
	file, err := directory.OpenFile(filepath.Base(path), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return errClosed
	}
	err = json.NewEncoder(file).Encode(struct {
		Key key.NodePrivate `json:"key"`
	}{private})
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return errClosed
	}
	if err := json.NewEncoder(output).Encode(struct {
		ClientKey key.NodePublic `json:"client_key"`
	}{private.Public()}); err != nil {
		return errClosed
	}
	return nil
}

func run() error {
	if os.Getenv("TS_DEBUG_ADDR") != "" {
		return errClosed
	}
	if len(os.Args) == 3 && os.Args[1] == "keygen" {
		return keygen(os.Args[2], os.Stdout)
	}
	if len(os.Args) != 3 || os.Args[1] != "proxy" {
		return errClosed
	}
	cfg, digest, err := readConfig(os.Args[2])
	if err != nil {
		return errClosed
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	ctx, deadline := context.WithDeadline(ctx, cfg.ExpiresAt)
	defer deadline()
	go watchLease(ctx, cancel, os.Args[2], digest)
	return proxy(ctx, cfg, os.Stdin, os.Stdout)
}

func main() {
	if err := run(); err != nil {
		os.Exit(1)
	}
}
