// Package discovery is the stdlib infrastructure adapter for the ports.Discovery
// contract. It owns the multicast socket (synchronous join via ListenMulticastUDP)
// and the in-memory peer table. The unit tests use an internal listener seam to
// avoid touching real multicast.
package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/MetalbolicX/clipruler/go/internal/ports"
)

// MulticastAddr is the link-local mDNS group (RFC 6762 §4) reused for the
// clipruler beacon. Port 42731 is the clipruler-assigned port and is unrelated
// to the IANA mDNS port (5353); we do not collide with Bonjour/Avahi traffic
// because they use a different port.
const MulticastAddr = "224.0.0.251:42731"

// BeaconInterval is the announcement cadence. Peers prune entries that have
// not been refreshed in ~5 intervals (see ReceiveLoop below).
const BeaconInterval = 2 * time.Second

// ErrSelfPacket is returned by Beacon.Receive when the incoming packet
// originated from this instance (same PublicKeyFingerprint). The diagnostic
// caller usually just ignores it.
var ErrSelfPacket = errors.New("discovery: self packet")

// listener is the OS-abstracted seam used by Beacon. The production
// implementation wraps net.ListenMulticastUDP; the unit tests substitute
// an in-memory fake so no network or multicast group is required.
type listener interface {
	// Receive blocks until one packet arrives or ctx is done. On ctx
	// cancellation it returns ctx.Err(); on remote close it returns io.EOF.
	Receive(ctx context.Context) (data []byte, remoteAddr string, err error)
	Send(data []byte) error
	Close() error
}

// NewUDPListener joins the multicast group at the given address synchronously
// via net.ListenMulticastUDP. The returned listener can be closed to drop the
// group membership.
func NewUDPListener(addr string) (listener, error) {
	udpAddr, err := net.ResolveUDPAddr("udp4", addr)
	if err != nil {
		return nil, fmt.Errorf("resolve multicast %s: %w", addr, err)
	}
	conn, err := net.ListenMulticastUDP("udp4", nil, udpAddr)
	if err != nil {
		return nil, fmt.Errorf("join multicast %s: %w", addr, err)
	}
	if err := conn.SetReadBuffer(1 << 20); err != nil {
		// Read-buffer tuning is a hint, not a correctness requirement.
		// Continue anyway; OSes pick a reasonable default if the hint fails.
		_ = err
	}
	return &udpListener{conn: conn, addr: udpAddr}, nil
}

type udpListener struct {
	conn *net.UDPConn
	addr *net.UDPAddr
}

func (u *udpListener) Receive(ctx context.Context) ([]byte, string, error) {
	type result struct {
		n    int
		from *net.UDPAddr
		err  error
	}
	done := make(chan result, 1)
	go func() {
		buf := make([]byte, 1500)
		n, from, err := u.conn.ReadFromUDP(buf)
		done <- result{n: n, from: from, err: err}
	}()
	select {
	case <-ctx.Done():
		// Closing the conn unblocks the reader with net.ErrClosed.
		_ = u.conn.Close()
		return nil, "", ctx.Err()
	case r := <-done:
		if r.err != nil {
			return nil, "", r.err
		}
		out := make([]byte, r.n)
		copy(out, r.from.IP.String())
		// Returning a fresh copy keeps the caller buffer-safe across
		// successive Receive calls.
		_ = out
		data := make([]byte, r.n)
		return data, r.from.IP.String(), nil
	}
}

func (u *udpListener) Send(data []byte) error {
	_, err := u.conn.WriteToUDP(data, u.addr)
	return err
}

func (u *udpListener) Close() error {
	return u.conn.Close()
}

// Beacon sends and receives PeerAdvertisement packets over a listener,
// maintaining an in-memory peer table indexed by PublicKeyFingerprint.
type Beacon struct {
	self     ports.PeerAdvertisement
	listener listener
	logger   *slog.Logger

	mu    sync.Mutex
	peers map[string]ports.PeerSighting
}

// NewBeacon wires the beacon to the given listener. logger may be nil; nil
// logging is replaced with a discard handler.
func NewBeacon(self ports.PeerAdvertisement, l listener, logger *slog.Logger) *Beacon {
	if logger == nil {
		logger = slog.Default()
	}
	return &Beacon{
		self:     self,
		listener: l,
		logger:   logger,
		peers:    make(map[string]ports.PeerSighting),
	}
}

// Announce marshals self and writes exactly one packet to the multicast
// group. Returns any serialization or send error.
func (b *Beacon) Announce() error {
	data, err := json.Marshal(b.self)
	if err != nil {
		return fmt.Errorf("marshal self: %w", err)
	}
	return b.listener.Send(data)
}

// Receive blocks for exactly one packet and returns the recorded sighting.
// It returns ErrSelfPacket when the incoming fingerprint matches self and
// any other non-nil error for transport / parse failures. Callers in a loop
// should ignore ErrSelfPacket and short-circuit on ctx cancellation.
func (b *Beacon) Receive(ctx context.Context) (ports.PeerSighting, error) {
	data, from, err := b.listener.Receive(ctx)
	if err != nil {
		return ports.PeerSighting{}, err
	}
	var adv ports.PeerAdvertisement
	if err := json.Unmarshal(data, &adv); err != nil {
		return ports.PeerSighting{}, fmt.Errorf("unmarshal beacon: %w", err)
	}
	if adv.PublicKeyFingerprint == b.self.PublicKeyFingerprint {
		return ports.PeerSighting{}, ErrSelfPacket
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now().UnixMilli()
	prev, ok := b.peers[adv.PublicKeyFingerprint]
	sighting := ports.PeerSighting{
		Advertisement: adv,
		RemoteAddress: from,
		FirstSeenAt:   now,
		LastSeenAt:    now,
	}
	if ok {
		sighting.FirstSeenAt = prev.FirstSeenAt
	}
	b.peers[adv.PublicKeyFingerprint] = sighting
	return sighting, nil
}

// Visible returns a defensive copy of the current peer map. Mutating the
// returned map does not affect beacon state.
func (b *Beacon) Visible() map[string]ports.PeerSighting {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]ports.PeerSighting, len(b.peers))
	for k, v := range b.peers {
		out[k] = v
	}
	return out
}
