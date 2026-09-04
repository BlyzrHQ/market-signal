package triggercli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const fixtureKey = "tr_dev_synthetic_not_a_real_key"

type memoryStore struct{ key string }

func (s *memoryStore) Get() (string, error) {
	if s.key == "" {
		return "", errors.New("missing")
	}
	return s.key, nil
}
func (s *memoryStore) Set(v string) error { s.key = v; return nil }
func (s *memoryStore) Delete() error      { s.key = ""; return nil }
func testOptions(server *httptest.Server, store *memoryStore) options {
	return options{store: store, env: func(string) string { return "" }, connect: func(key string) (*Client, error) {
		c, err := newClient(key)
		if err == nil {
			c.base = server.URL
		}
		return c, err
	}}
}

func TestConfigureVerifiesKeyWithoutEcho(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer "+fixtureKey || r.URL.Path != "/api/v1/runs" {
			t.Error("wrong authentication endpoint")
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer server.Close()
	store := &memoryStore{}
	root := newRoot("test", testOptions(server, store))
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetIn(strings.NewReader(fixtureKey))
	root.SetArgs([]string{"configure", "--stdin"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || store.key != fixtureKey || strings.Contains(out.String(), fixtureKey) {
		t.Fatal("unsafe credential handling")
	}
}
func TestReportCallsOnlyTriggerAndReturnsStructuredOutput(t *testing.T) {
	var posts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+fixtureKey {
			t.Fatal("key missing")
		}
		switch r.URL.Path {
		case "/api/v1/tasks/market-signal-direct-report/trigger":
			posts++
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			payload := body["payload"].(map[string]any)
			if payload["domain"] != "primary.example" || payload["comparisons"] != float64(20) || payload["rivals"] != float64(3) {
				t.Error("wrong inputs")
			}
			if body["options"].(map[string]any)["idempotencyKey"] != "fixture:1" {
				t.Error("missing idempotency")
			}
			_, _ = w.Write([]byte(`{"id":"run_fixture"}`))
		case "/api/v3/runs/run_fixture":
			_, _ = w.Write([]byte(`{"id":"run_fixture","status":"COMPLETED","taskIdentifier":"market-signal-direct-report","payload":{"contractVersion":"1","domain":"primary.example","comparisons":20,"rivals":3,"requestId":"fixture:1"},"output":{"contractVersion":"1","status":"complete","comparisons":[],"competitors":[]}}`))
		default:
			t.Errorf("unexpected endpoint %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	root := newRoot("test", testOptions(server, &memoryStore{fixtureKey}))
	var out, errOut bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&errOut)
	root.SetArgs([]string{"report", "primary.example", "--comparisons", "20", "--rivals", "3", "--request-id", "fixture:1"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if posts != 1 || !strings.Contains(out.String(), `"comparisons"`) {
		t.Fatal("missing result")
	}
	if strings.Contains(out.String()+errOut.String(), fixtureKey) {
		t.Fatal("key leaked")
	}
}
func TestMissingDomainAndPlaceholderNeverConnect(t *testing.T) {
	for _, args := range [][]string{{"report"}, {"report", "<domain>", "--request-id", "fixture:1"}, {"report", "127.0.0.1", "--request-id", "fixture:1"}, {"report", "primary.example"}} {
		root := newRoot("test", options{store: &memoryStore{}, env: func(string) string { return "" }, connect: func(string) (*Client, error) { t.Fatal("must not connect"); return nil, nil }})
		root.SetArgs(args)
		if root.Execute() == nil {
			t.Fatal("invalid args accepted")
		}
	}
}
func TestRedirectDoesNotForwardSecret(t *testing.T) {
	var received bool
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { received = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	c, _ := newClient(fixtureKey)
	c.base = server.URL
	if c.verify(context.Background()) == nil || received {
		t.Fatal("redirect followed")
	}
}
func TestSubmissionFailureIsNotRetriedAndBodyIsSanitized(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(500)
		_, _ = w.Write([]byte(fixtureKey))
	}))
	defer server.Close()
	c, _ := newClient(fixtureKey)
	c.base = server.URL
	_, err := c.trigger(context.Background(), "market-signal-direct-report", "fixture:1", map[string]any{})
	if calls != 1 || err == nil || strings.Contains(err.Error(), fixtureKey) || !strings.Contains(err.Error(), "unknown") {
		t.Fatal("unsafe retry/error")
	}
}
func TestResultAndWaitDoNotSubmit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			t.Fatal("read submitted work")
		}
		_, _ = w.Write([]byte(`{"id":"run_fixture","status":"COMPLETED","taskIdentifier":"market-signal-direct-report","payload":{"contractVersion":"1","domain":"primary.example","comparisons":20,"rivals":3,"requestId":"fixture:1"},"output":{"contractVersion":"1","status":"limited"}}`))
	}))
	defer server.Close()
	for _, command := range []string{"result", "wait"} {
		root := newRoot("test", testOptions(server, &memoryStore{fixtureKey}))
		var out bytes.Buffer
		root.SetOut(&out)
		root.SetArgs([]string{command, "run_fixture"})
		if ExitCode(root.Execute()) != 2 {
			t.Fatal("limited report must exit 2")
		}
	}
}

func TestEveryResearchCommandAndProbeUsesItsDirectTask(t *testing.T) {
	for _, name := range []string{"report", "crawl", "compare", "doctor", "tools"} {
		t.Run(name, func(t *testing.T) {
			task := "market-signal-direct-" + name
			if name == "doctor" || name == "tools" {
				task = "market-signal-direct-capabilities"
			}
			var posts int
			var payload map[string]any
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "POST" {
					posts++
					if r.URL.Path != "/api/v1/tasks/"+task+"/trigger" {
						t.Error("wrong task")
					}
					var body map[string]any
					_ = json.NewDecoder(r.Body).Decode(&body)
					payload = body["payload"].(map[string]any)
					_, _ = w.Write([]byte(`{"id":"run_fixture"}`))
					return
				}
				status := "complete"
				if name == "doctor" || name == "tools" {
					status = "ready"
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"id": "run_fixture", "status": "COMPLETED", "taskIdentifier": task, "payload": payload, "output": map[string]any{"contractVersion": "1", "status": status}})
			}))
			defer server.Close()
			root := newRoot("test", testOptions(server, &memoryStore{fixtureKey}))
			var out bytes.Buffer
			root.SetOut(&out)
			root.SetErr(&out)
			args := []string{name}
			if name != "doctor" && name != "tools" {
				args = append(args, "primary.example", "--request-id", "fixture:1", "--no-wait")
			}
			root.SetArgs(args)
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if posts != 1 {
				t.Fatal("wrong submission count")
			}
		})
	}
}

func TestReusedIDWithDifferentInputFailsWithoutSecondSubmission(t *testing.T) {
	var posts int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" {
			posts++
			_, _ = w.Write([]byte(`{"id":"run_fixture"}`))
			return
		}
		_, _ = w.Write([]byte(`{"id":"run_fixture","status":"QUEUED","taskIdentifier":"market-signal-direct-report","payload":{"contractVersion":"1","domain":"other.example","comparisons":20,"rivals":10,"requestId":"fixture:1"}}`))
	}))
	defer server.Close()
	root := newRoot("test", testOptions(server, &memoryStore{fixtureKey}))
	var out bytes.Buffer
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetArgs([]string{"report", "primary.example", "--request-id", "fixture:1", "--no-wait"})
	if ExitCode(root.Execute()) != 9 || posts != 1 {
		t.Fatal("input conflict not blocked")
	}
}
