package gateway

import (
	"net/http"
	"testing"
	"time"

	"opencode2api/internal/config"
)

func testPerformanceConfig() config.PerformanceConfig {
	return config.PerformanceConfig{MaxIdleConns: 8, MaxIdleConnsPerHost: 8, IdleConnTimeoutSeconds: 30, ConnectTimeoutSeconds: 5, FailureCooldownSeconds: 15}
}

// A #pool entry must dial like a rotating endpoint: no HTTP/2, no keep-alive
// idle pool, and an explicit empty TLSNextProto so a cloned DefaultTransport
// cannot reuse the tunnel it configured before the first dial.
func TestPoolTransportForcesFreshConnection(t *testing.T) {
	transports, err := newTransportPool([]string{"http://127.0.0.1:7890#pool", "direct"}, testPerformanceConfig(), 0)
	if err != nil {
		t.Fatalf("newTransportPool failed: %v", err)
	}
	pool := transports.items[0]
	if !pool.pool {
		t.Fatal("the #pool entry was not marked as a rotating pool")
	}
	transport := pool.client.Transport.(*http.Transport)
	if transport.DisableKeepAlives != true || transport.ForceAttemptHTTP2 != false {
		t.Fatalf("pool transport keeps connections alive: DisableKeepAlives=%v ForceAttemptHTTP2=%v", transport.DisableKeepAlives, transport.ForceAttemptHTTP2)
	}
	if transport.TLSNextProto == nil || len(transport.TLSNextProto) != 0 {
		t.Fatalf("pool transport still negotiates HTTP/2: TLSNextProto=%v", transport.TLSNextProto)
	}
	if transport.TLSClientConfig == nil || len(transport.TLSClientConfig.NextProtos) != 1 || transport.TLSClientConfig.NextProtos[0] != "http/1.1" {
		t.Fatalf("pool transport TLS ALPN = %v, want [http/1.1]", transport.TLSClientConfig)
	}
	static := transports.items[1]
	if static.pool || static.client.Transport.(*http.Transport).ForceAttemptHTTP2 != true {
		t.Fatal("the static entry must keep the default pooling behavior")
	}
}

// When every static proxy is cooling, Next must fall back to the node that
// recovers first instead of returning nil, which used to turn a rate-limited
// exit into an immediate "503/502 no healthy anonymous proxies" failure.
func TestAnonymousCursorFallsBackToCoolingNodes(t *testing.T) {
	transports, err := newTransportPool([]string{"http://127.0.0.1:7890", "http://127.0.0.1:7891"}, testPerformanceConfig(), 0)
	if err != nil {
		t.Fatalf("newTransportPool failed: %v", err)
	}
	pool := newAnonymousPool(true, transports, 15*time.Second)
	now := time.Now().UnixNano()
	pool.nodes[0].cooldownUntil.Store(now + int64(90*time.Second))
	pool.nodes[1].cooldownUntil.Store(now + int64(30*time.Second))

	cursor := pool.CursorFor("")
	visited := map[int]int{}
	for range 2 {
		node := cursor.Next()
		if node == nil {
			t.Fatal("cursor returned nil while cooling nodes were still available")
		}
		visited[node.proxy.index]++
	}
	if len(visited) != 2 {
		t.Fatalf("cursor fell back to %d distinct nodes, want both cooling nodes", len(visited))
	}
	if node := cursor.Next(); node != nil {
		t.Fatalf("cursor revisited proxies after exhausting the pool: index=%d", node.proxy.index)
	}

	// The earliest-expiring node must be offered first.
	stats := pool.CursorFor("")
	if node := stats.Next(); node == nil || node.proxy.index != 1 {
		t.Fatalf("fallback did not prefer the earliest-expiring node: %v", node)
	}
}

// A #pool entry keeps being offered after one pass so retry.max_attempts can
// draw a fresh upstream connection (and exit IP) on every attempt.
func TestAnonymousCursorCyclesPoolEntries(t *testing.T) {
	transports, err := newTransportPool([]string{"http://127.0.0.1:7890#pool"}, testPerformanceConfig(), 0)
	if err != nil {
		t.Fatalf("newTransportPool failed: %v", err)
	}
	pool := newAnonymousPool(true, transports, 15*time.Second)
	pool.nodes[0].cooldownUntil.Store(time.Now().Add(time.Minute).UnixNano())

	cursor := pool.CursorFor("")
	for attempt := 1; attempt <= 3; attempt++ {
		node := cursor.Next()
		if node == nil {
			t.Fatalf("pool entry was not offered on attempt %d", attempt)
		}
	}
}
