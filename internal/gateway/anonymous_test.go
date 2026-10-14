package gateway

import (
	"context"
	"regexp"
	"testing"

	"opencode2api/internal/httpx"
	"opencode2api/internal/identity"
	wire "opencode2api/internal/protocol"
)

var (
	hex40          = regexp.MustCompile(`^[0-9a-f]{40}$`)
	userAgentShape = regexp.MustCompile(`^opencode/[^/]+/[^/]+/[^/]+$`)
)

func requestIDs() identity.RequestIDs {
	return identity.RequestIDs{
		Session: "ses_ecc31ef8dffer4cycyzKaEPJUh",
		Request: "req_0123456789abcdef",
		Project: "prj_0123456789abcdef01234567",
	}
}

// Upstream fingerprints the client on every tier, so both the keyless and the
// keyed lanes must carry the client's header set and none of the gateway's own
// additions.
func TestUpstreamRequestMirrorsClientHeaders(t *testing.T) {
	cases := []struct {
		name string
		base string
		key  string
	}{
		{"anonymous", "https://opencode.ai/inference", "public"},
		{"keyed-zen", "https://opencode.ai/zen", "sk-test"},
		{"keyed-inference", "https://opencode.ai/inference/openai", "sk-test"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ids := requestIDs()
			req, err := newUpstreamRequest(context.Background(), tc.base, wire.Chat, []byte(`{}`), ids, tc.key)
			if err != nil {
				t.Fatalf("newUpstreamRequest: %v", err)
			}
			if got, want := req.URL.String(), tc.base+"/v1/chat/completions"; got != want {
				t.Fatalf("endpoint = %q, want %q", got, want)
			}
			if got := req.Header.Get("User-Agent"); got != httpx.UserAgent() {
				t.Fatalf("User-Agent = %q, want %q", got, httpx.UserAgent())
			}
			if !userAgentShape.MatchString(httpx.UserAgent()) {
				t.Fatalf("User-Agent %q is not opencode/<channel>/<version>/<name>", httpx.UserAgent())
			}
			if got := req.Header.Get("x-opencode-client"); got != "cli" {
				t.Fatalf("x-opencode-client = %q", got)
			}
			if got := req.Header.Get("x-opencode-session-id"); got != ids.Session {
				t.Fatalf("x-opencode-session-id = %q, want %q", got, ids.Session)
			}
			if got := req.Header.Get("x-opencode-session"); got != ids.Session {
				t.Fatalf("x-opencode-session = %q, want %q", got, ids.Session)
			}
			if got := req.Header.Get("x-opencode-project"); !hex40.MatchString(got) {
				t.Fatalf("x-opencode-project = %q, want 40 lowercase hex", got)
			}
			if got := req.Header.Get("x-opencode-request"); got != "" {
				t.Fatalf("x-opencode-request = %q, want absent", got)
			}
			if got := req.Header.Get("Authorization"); got != "Bearer "+tc.key {
				t.Fatalf("Authorization = %q", got)
			}
		})
	}
}

// Injected core tools must carry the genuine OpenCode definition: the free tier
// rejects a stub that only reuses the name.
func TestAnonymousToolUsesGenuineDefinition(t *testing.T) {
	for _, name := range anonymousCoreTools {
		definition, ok := knownOpencodeTool(name)
		if !ok {
			t.Fatalf("no genuine definition for core tool %q", name)
		}
		if definition.Description == "" || len(definition.Parameters) == 0 {
			t.Fatalf("core tool %q has an empty genuine definition", name)
		}
		rendered := anonymousTool(wire.Chat, name)
		function, ok := rendered["function"].(map[string]any)
		if !ok {
			t.Fatalf("core tool %q rendered without a function object", name)
		}
		if function["description"] != definition.Description {
			t.Fatalf("core tool %q did not use the genuine description", name)
		}
	}
}

// A downstream tool that reuses a recognised name with its own schema is
// rewritten, while unknown names pass through untouched.
func TestEnsureAnonymousToolsRewritesKnownNames(t *testing.T) {
	payload := map[string]any{
		"tools": []any{
			map[string]any{"type": "function", "function": map[string]any{
				"name": "read", "description": "my own reader", "parameters": map[string]any{"type": "object", "properties": map[string]any{}},
			}},
			map[string]any{"type": "function", "function": map[string]any{
				"name": "get_weather", "description": "Weather lookup", "parameters": map[string]any{"type": "object", "properties": map[string]any{}},
			}},
		},
	}
	if !ensureAnonymousTools(payload, wire.Chat) {
		t.Fatal("expected the payload to change")
	}
	tools, ok := payload["tools"].([]any)
	if !ok {
		t.Fatal("tools is not a slice")
	}
	byName := map[string]map[string]any{}
	for _, item := range tools {
		entry := item.(map[string]any)
		function := entry["function"].(map[string]any)
		byName[function["name"].(string)] = function
	}
	if byName["read"]["description"] == "my own reader" {
		t.Fatal("recognised tool name kept its downstream definition")
	}
	if byName["get_weather"]["description"] != "Weather lookup" {
		t.Fatal("unknown tool name was rewritten")
	}
	for _, name := range anonymousCoreTools {
		if _, ok := byName[name]; !ok {
			t.Fatalf("core tool %q was not injected", name)
		}
	}
}
