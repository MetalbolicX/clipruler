package discovery

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/MetalbolicX/clipruler/go/internal/ports"
)

type fakePacket struct {
	data []byte
	from string
}

// fakeListener implements the unexported listener seam without touching the
// real network. All concurrency is guarded by a single mutex plus a buffered
// channel; the tests rely on Go's default deterministic scheduler.
type fakeListener struct {
	mu       sync.Mutex
	incoming chan fakePacket
	sent     [][]byte
	closed   bool
}

func newFakeListener() *fakeListener {
	return &fakeListener{incoming: make(chan fakePacket, 16)}
}

func (f *fakeListener) Receive(ctx context.Context) ([]byte, string, error) {
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	case p, ok := <-f.incoming:
		if !ok {
			return nil, "", io.EOF
		}
		return p.data, p.from, nil
	}
}

func (f *fakeListener) Send(data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return io.ErrClosedPipe
	}
	cp := make([]byte, len(data))
	copy(cp, data)
	f.sent = append(f.sent, cp)
	return nil
}

func (f *fakeListener) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	return nil
}

func (f *fakeListener) feed(data []byte, from string) {
	f.incoming <- fakePacket{data: data, from: from}
}

func (f *fakeListener) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sent)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(io.Discard, nil))
}

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func TestBeaconReceiveRecordsPeer(t *testing.T) {
	l := newFakeListener()
	self := ports.PeerAdvertisement{
		Name: "self", PublicKeyFingerprint: "self-fp",
		TLSPort: 0, ProtocolVersion: 1,
	}
	b := NewBeacon(self, l, discardLogger())

	remote := ports.PeerAdvertisement{
		Name: "remote", PublicKeyFingerprint: "remote-fp",
		TLSPort: 9000, ProtocolVersion: 1,
	}
	l.feed(mustMarshal(t, remote), "10.0.0.5")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	got, err := b.Receive(ctx)
	if err != nil {
		t.Fatalf("receive: %v", err)
	}
	if got.Advertisement != remote {
		t.Fatalf("sighting mismatch: got %+v want %+v", got.Advertisement, remote)
	}
	if got.RemoteAddress != "10.0.0.5" {
		t.Fatalf("wrong from: %q", got.RemoteAddress)
	}

	peers := b.Visible()
	if _, ok := peers["remote-fp"]; !ok {
		t.Fatalf("peer not recorded: %+v", peers)
	}
}

func TestBeaconReceiveIgnoresSelf(t *testing.T) {
	l := newFakeListener()
	self := ports.PeerAdvertisement{
		Name: "self", PublicKeyFingerprint: "self-fp",
		TLSPort: 0, ProtocolVersion: 1,
	}
	b := NewBeacon(self, l, discardLogger())

	l.feed(mustMarshal(t, self), "127.0.0.1")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, err := b.Receive(ctx)
	if !errors.Is(err, ErrSelfPacket) {
		t.Fatalf("expected ErrSelfPacket, got %v", err)
	}
	if got := b.Visible(); len(got) != 0 {
		t.Fatalf("self packet must not be recorded: %+v", got)
	}
}

func TestBeaconReceiveRejectsMalformed(t *testing.T) {
	l := newFakeListener()
	self := ports.PeerAdvertisement{PublicKeyFingerprint: "fp"}
	b := NewBeacon(self, l, discardLogger())
	l.feed([]byte("not-json"), "1.2.3.4")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, err := b.Receive(ctx)
	if err == nil {
		t.Fatalf("expected error on malformed json")
	}
	if errors.Is(err, ErrSelfPacket) {
		t.Fatalf("malformed json must not be classified as self")
	}
}

func TestBeaconAnnounceSendsMarshaledSelf(t *testing.T) {
	l := newFakeListener()
	self := ports.PeerAdvertisement{
		Name: "n", PublicKeyFingerprint: "fp",
		TLSPort: 42, ProtocolVersion: 1,
	}
	b := NewBeacon(self, l, discardLogger())

	if err := b.Announce(); err != nil {
		t.Fatalf("announce: %v", err)
	}
	if got := l.sentCount(); got != 1 {
		t.Fatalf("expected 1 send, got %d", got)
	}
	l.mu.Lock()
	sent := l.sent[0]
	l.mu.Unlock()
	var roundTrip ports.PeerAdvertisement
	if err := json.Unmarshal(sent, &roundTrip); err != nil {
		t.Fatalf("unmarshal sent: %v", err)
	}
	if roundTrip != self {
		t.Fatalf("wire mismatch: got %+v want %+v", roundTrip, self)
	}
}

func TestBeaconReceiveContextCancellation(t *testing.T) {
	l := newFakeListener()
	b := NewBeacon(ports.PeerAdvertisement{PublicKeyFingerprint: "fp"}, l, discardLogger())

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already done

	_, err := b.Receive(ctx)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}

func TestBeaconVisibleReturnsCopy(t *testing.T) {
	l := newFakeListener()
	b := NewBeacon(ports.PeerAdvertisement{PublicKeyFingerprint: "self"}, l, discardLogger())
	remote := ports.PeerAdvertisement{
		Name: "r", PublicKeyFingerprint: "r-fp",
		TLSPort: 1, ProtocolVersion: 1,
	}
	l.feed(mustMarshal(t, remote), "10.0.0.6")

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := b.Receive(ctx); err != nil {
		t.Fatalf("receive: %v", err)
	}

	first := b.Visible()
	delete(first, "r-fp")
	second := b.Visible()
	if _, ok := second["r-fp"]; !ok {
		t.Fatalf("mutating Visible() snapshot affected internal state")
	}
}

// TestUDPListenerReusableAcrossCtxCancel exercises the real udpListener on the
// loopback UDP path (no multicast group required). It pins down both T1.1 review
// defects: the receive buffer must be propagated, and the listener must remain
// usable after a ctx cancellation does not close the underlying conn.
func TestUDPListenerReusableAcrossCtxCancel(t *testing.T) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := conn.LocalAddr().(*net.UDPAddr)
	l := &udpListener{conn: conn, addr: addr}
	defer l.Close()

	shortCtx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	_, _, err = l.Receive(shortCtx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) && !errors.Is(err, context.Canceled) {
		t.Fatalf("expected DeadlineExceeded/Canceled, got %v", err)
	}
	if errors.Is(err, net.ErrClosed) {
		t.Fatalf("conn was closed on ctx cancel; defect B is back")
	}

	sender, err := net.DialUDP("udp4", nil, addr)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer sender.Close()
	payload := []byte("hello-beacon")
	if _, err := sender.Write(payload); err != nil {
		t.Fatalf("write: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	got, from, err := l.Receive(ctx)
	if err != nil {
		t.Fatalf("second receive: %v", err)
	}
	if string(got) != string(payload) {
		t.Fatalf("payload mismatch: got %q want %q", got, payload)
	}
	if from == "" {
		t.Fatalf("expected non-empty source address")
	}
}
