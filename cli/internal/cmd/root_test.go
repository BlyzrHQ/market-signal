package cmd

import (
	"bytes"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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

func TestReportCommandRendersDecisionSummary(t *testing.T) {
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
	root.SetArgs([]string{"report", "https://myjam.co.uk/", "--base-url", server.URL, "--quiet"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	output := stdout.String()
	for _, expected := range []string{"myjam.co.uk", "1 verified", "2 rows", "2/2 fetched"} {
		if !strings.Contains(output, expected) {
			t.Fatalf("expected %q in output:\n%s", expected, output)
		}
	}
}

func TestReportCommandUsesContractDriftExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	root := NewRoot("test")
	root.SetArgs([]string{"report", "myjam.co.uk", "--base-url", server.URL, "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 3 {
		t.Fatalf("expected exit code 3, got %v", err)
	}
}

func TestJSONReportPreservesPayloadAndReturnsGapExitCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		payload := strings.Replace(reportFixture, `{"type":"summary","id":"scan-summary"}`, `{"type":"summary","id":"scan-summary"},{"type":"market-profile","id":"market-profile","gaps":["Discovery lane timed out"]}`, 1)
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()

	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"report", "myjam.co.uk", "--base-url", server.URL, "--output", "json", "--quiet"})
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
