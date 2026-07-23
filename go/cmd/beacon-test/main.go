// Command beacon-test is the Phase 1 diagnostic binary for the Go migration.
// It joins 224.0.0.251:42731 synchronously, advertises itself every 2s, and
// prints each sighting from a peer. SIGINT/SIGTERM shutdown is graceful.
//
// Scope is intentionally narrow: no domain, no TLS, no trust, no daemon.
// This is the migration's first reality check — can Go actually see other
// clipruler-class beacons on the same LAN, with the same group?
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/MetalbolicX/clipruler/go/internal/infra/discovery"
	"github.com/MetalbolicX/clipruler/go/internal/ports"
)

const (
	multicastAddr     = discovery.MulticastAddr
	beaconEvery       = discovery.BeaconInterval
	receivePollWindow = 500 * time.Millisecond
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "beacon-test:", err)
		os.Exit(1)
	}
}

func run() error {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	logger.Info("beacon-test starting",
		"component", "beacon-test",
		"group", multicastAddr,
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	self := ports.PeerAdvertisement{
		Name:                 fmt.Sprintf("beacon-test-%s", safeHostname()),
		PublicKeyFingerprint: randomFingerprint(),
		TLSPort:              0, // discovery-only; production peers publish their real TLS port.
		ProtocolVersion:      1,
	}
	logger.Info("self advertised",
		"component", "beacon-test",
		"name", self.Name,
		"fingerprint", self.PublicKeyFingerprint,
	)

	listener, err := discovery.NewUDPListener(multicastAddr)
	if err != nil {
		return fmt.Errorf("join multicast %s: %w", multicastAddr, err)
	}
	defer listener.Close()

	beacon := discovery.NewBeacon(self, listener, logger)

	// Fire one announce synchronously so any immediate send error surfaces
	// before we commit to a long-running loop.
	if err := beacon.Announce(); err != nil {
		return fmt.Errorf("initial announce: %w", err)
	}

	// Beacon sender runs in its own goroutine; receiver blocks the main
	// goroutine until ctx is cancelled.
	go sender(ctx, beacon, beaconEvery, logger)
	recvLoop(ctx, beacon, logger)

	logger.Info("beacon-test stopped", "component", "beacon-test")
	return nil
}

func sender(ctx context.Context, beacon *discovery.Beacon, interval time.Duration, logger *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := beacon.Announce(); err != nil {
				logger.Warn("announce failed",
					"component", "beacon-test",
					"err", err.Error(),
				)
			}
		}
	}
}

func recvLoop(ctx context.Context, beacon *discovery.Beacon, logger *slog.Logger) {
	for {
		readCtx, cancel := context.WithTimeout(ctx, receivePollWindow)
		sighting, err := beacon.Receive(readCtx)
		cancel()
		switch {
		case err == nil:
			logger.Info("peer sighting",
				"component", "beacon-test",
				"remote", sighting.RemoteAddress,
				"fingerprint", sighting.Advertisement.PublicKeyFingerprint,
				"name", sighting.Advertisement.Name,
				"tlsPort", sighting.Advertisement.TLSPort,
				"protocolVersion", sighting.Advertisement.ProtocolVersion,
			)
			fmt.Printf("[BEACON] from %s fingerprint=%s port=%d\n",
				sighting.RemoteAddress,
				sighting.Advertisement.PublicKeyFingerprint,
				sighting.Advertisement.TLSPort,
			)
		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			if ctx.Err() != nil {
				return
			}
		case errors.Is(err, discovery.ErrSelfPacket):
			// Loopback bounce of our own beacon; ignore.
			continue
		default:
			if ctx.Err() != nil {
				return
			}
			logger.Debug("receive failed",
				"component", "beacon-test",
				"err", err.Error(),
			)
		}
	}
}

// randomFingerprint returns a short, opaque, per-process identifier so two
// beacon-test instances running on the same machine do not collapse into one
// in the receiver's peer table. The format matches the spec example
// dev-AABBCC-test.
func randomFingerprint() string {
	b := make([]byte, 3)
	_, _ = rand.Read(b)
	return fmt.Sprintf("dev-%s-test", hex.EncodeToString(b))
}

func safeHostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown"
	}
	return h
}
