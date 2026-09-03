package cmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const validHostedAPIKey = "msk_live_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"

const reportFixture = `{
  "ok": true,
  "live": true,
  "primaryDomain": "myjam.co.uk",
  "results": [
    {"domain":"myjam.co.uk","role":"primary","pages":[],"products":[{}],"gaps":[],"coverage":{"pagesRequested":2,"pagesFetched":2,"maxPages":5,"robotsChecked":true},"fetchedAt":"2026-07-15T10:00:00Z"},
    {"domain":"rival.example","role":"discovered-competitor","pages":[],"products":[{}],"gaps":[],"coverage":{"pagesRequested":1,"pagesFetched":1,"maxPages":3,"robotsChecked":true},"fetchedAt":"2026-07-15T10:00:01Z"}
  ],
  "document": {"version":"1","generatedAt":"2026-07-15T10:00:02Z","blocks":[
    {"type":"summary","id":"scan-summary"},
    {"type":"competitor","id":"competitor-rival","domain":"rival.example","discoverySourceUrl":"https://rival.example/","websiteSourceUrl":"https://rival.example/"},
    {"type":"product-comparison","id":"product-comparison","rows":[{},{}]}
  ]},
  "crawl":{"maxPagesPerDomain":5,"robotsAware":true,"generatedAt":"2026-07-15T10:00:02Z"}
}`

func TestCrawlCommandRendersDecisionSummary(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/crawl" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(reportFixture))
	}))
	defer server.Close()

	var stdout, stderr bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs([]string{"crawl", "https://myjam.co.uk/", "--base-url", server.URL, "--quiet"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	for _, expected := range []string{"myjam.co.uk", "LIVE — contract v1 validated", "rival.example", "2/2 fetched"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("expected %q in output:\n%s", expected, output)
		}
	}
}

func TestCrawlCommandUsesContractDriftExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	root := NewRoot("test")
	root.SetArgs([]string{"crawl", "myjam.co.uk", "--base-url", server.URL, "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 3 {
		t.Fatalf("expected exit code 3, got %v", err)
	}
}

func TestJSONCrawlPreservesPayloadAndReturnsGapExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload := strings.Replace(reportFixture, `{"type":"summary","id":"scan-summary"}`, `{"type":"summary","id":"scan-summary"},{"type":"market-profile","id":"market-profile","gaps":["Discovery lane timed out"]}`, 1)
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"crawl", "myjam.co.uk", "--base-url", server.URL, "--output", "json", "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 2 {
		t.Fatalf("expected exit code 2, got %v", err)
	}
	if !strings.Contains(stdout.String(), "Discovery lane timed out") {
		t.Fatalf("JSON payload was not preserved:\n%s", stdout.String())
	}
}

func TestReportCommandUsesTransportExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("<!DOCTYPE html><title>Sign in</title>"))
	}))
	serverURL := server.URL
	server.Close()

	root := NewRoot("test")
	root.SetArgs([]string{"report", "myjam.co.uk", "--base-url", serverURL, "--timeout", "200ms", "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 4 {
		t.Fatalf("expected exit code 4, got %v", err)
	}
}

func TestAdsCommandIsNotAvailable(t *testing.T) {
	root := NewRoot("test")
	root.SetArgs([]string{"ads", "myjam.co.uk"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), `unknown command "ads"`) {
		t.Fatalf("expected ads to be removed from the CLI, got %v", err)
	}
}

func TestRootHelpKeepsTheHostedCustomerFlowSimple(t *testing.T) {
	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	help := stdout.String()
	for _, visible := range []string{"login", "logout", "report", "version"} {
		if !strings.Contains(help, visible) {
			t.Fatalf("expected %q in customer help:\n%s", visible, help)
		}
	}
	for _, hidden := range []string{"crawl ", "submit ", "wait ", "result ", "completion ", "--base-url", "--timeout"} {
		if strings.Contains(help, hidden) {
			t.Fatalf("advanced command or flag %q leaked into customer help:\n%s", hidden, help)
		}
	}
}

func TestLoginAPIKeyFlagNeverEchoesAnAccidentallySuppliedSecret(t *testing.T) {
	root := NewRoot("test")
	root.SetArgs([]string{"login", "--api-key=" + validHostedAPIKey})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "use --api-key without a value") {
		t.Fatalf("expected sanitized flag error, got %v", err)
	}
	if strings.Contains(err.Error(), validHostedAPIKey) {
		t.Fatal("flag error echoed the API key")
	}
}

func TestNonInteractiveAPIKeyLoginRequiresEnvironmentVariable(t *testing.T) {
	t.Setenv("MARKET_SIGNAL_API_KEY", "")
	root := NewRoot("test")
	root.SetIn(strings.NewReader(validHostedAPIKey))
	root.SetArgs([]string{"login", "--api-key"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "set MARKET_SIGNAL_API_KEY for non-interactive use") {
		t.Fatalf("expected non-interactive environment guidance, got %v", err)
	}
}

func TestHostedAPIKeysCannotFollowAnOverriddenBaseURL(t *testing.T) {
	_, _, err := dependencies(&options{baseURL: "https://attacker.example", apiKey: validHostedAPIKey, timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "can be sent only") {
		t.Fatalf("expected exact-origin API key rejection, got %v", err)
	}
}

func TestCredentialEnvironmentVariablesAreMutuallyExclusive(t *testing.T) {
	_, _, err := dependencies(&options{baseURL: "https://signal.blyzr.com", apiKey: validHostedAPIKey, apiToken: "controlled-token", timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "set only one") {
		t.Fatalf("expected ambiguous credential rejection, got %v", err)
	}
}
