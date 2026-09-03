package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestClientExplainsHTMLResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("<!DOCTYPE html><title>Sign in</title>"))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Post(context.Background(), "/api/crawl", map[string]string{"domain": "example.com"})
	if err == nil || !strings.Contains(err.Error(), "browser sign-in") {
		t.Fatalf("expected actionable HTML error, got %v", err)
	}
}

func TestClientRetriesTransientGETFailureOnce(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		if attempts == 1 {
			http.Error(w, "temporary", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(context.Background(), "/api/test"); err != nil {
		t.Fatal(err)
	}
	if attempts != 2 {
		t.Fatalf("expected two attempts, got %d", attempts)
	}
}

func TestClientNeverRetriesPOSTAfterAmbiguousFailure(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts++
		http.Error(w, "temporary", http.StatusBadGateway)
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Post(context.Background(), "/api/reports", map[string]string{"commandId": "loop-1"}); err == nil {
		t.Fatal("expected the ambiguous POST failure to be returned")
	}
	if attempts != 1 {
		t.Fatalf("POST must not be retried automatically, got %d attempts", attempts)
	}
}

func TestClientSendsConfiguredAPITokenWithoutLoggingIt(t *testing.T) {
	const token = "local-api-token-12345678901234567890"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			t.Errorf("expected bearer API token, got %q", request.Header.Get("Authorization"))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Post(context.Background(), "/api/crawl", nil); err != nil {
		t.Fatal(err)
	}
}

func TestClientRefusesToSendAPITokenOverRemotePlainHTTP(t *testing.T) {
	const token = "local-api-token-12345678901234567890"
	_, err := NewClient("http://example.com", time.Second, token)
	if err == nil || !strings.Contains(err.Error(), "require HTTPS") {
		t.Fatalf("expected HTTPS safety error, got %v", err)
	}

	if _, err := NewClient("https://example.com", time.Second, token); err != nil {
		t.Fatalf("expected remote HTTPS to be accepted, got %v", err)
	}
}

func TestClientLoadsOAuthTokenForEveryRequestAndRetry(t *testing.T) {
	var requests int
	var tokenCalls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		expected := "Bearer token-" + fmt.Sprint(requests)
		if request.Header.Get("Authorization") != expected {
			t.Errorf("expected %q, got %q", expected, request.Header.Get("Authorization"))
		}
		if requests == 1 {
			http.Error(w, "temporary", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	client, err := NewClientWithTokenSource(server.URL, time.Second, func(context.Context) (string, error) {
		tokenCalls++
		return "token-" + fmt.Sprint(tokenCalls), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(context.Background(), "/api/test"); err != nil {
		t.Fatal(err)
	}
	if requests != 2 || tokenCalls != 2 {
		t.Fatalf("expected a fresh token lookup for both attempts; requests=%d tokenCalls=%d", requests, tokenCalls)
	}
}

func TestClientRefusesOAuthTokenSourceOverRemotePlainHTTP(t *testing.T) {
	_, err := NewClientWithTokenSource("http://example.com", time.Second, func(context.Context) (string, error) {
		return "token", nil
	})
	if err == nil || !strings.Contains(err.Error(), "require HTTPS") {
		t.Fatalf("expected OAuth HTTPS safety error, got %v", err)
	}
}

func TestClientGetPreservesQueryAndBearerToken(t *testing.T) {
	const token = "local-api-token-12345678901234567890"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/api/reports/report/result" || request.URL.Query().Get("requestId") != "loop-1" {
			t.Errorf("unexpected request %s %s", request.Method, request.URL.String())
			return
		}
		if request.Header.Get("Authorization") != "Bearer "+token {
			t.Error("configured bearer token was not forwarded")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"state":"pending"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second, token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(context.Background(), "/api/reports/report/result?requestId=loop-1"); err != nil {
		t.Fatal(err)
	}
}

func TestClientRejectsAbsoluteAPIPath(t *testing.T) {
	client, err := NewClient("http://localhost:3000", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Get(context.Background(), "https://attacker.example/path"); err == nil || !strings.Contains(err.Error(), "invalid API path") {
		t.Fatalf("expected absolute path rejection, got %v", err)
	}
}

func TestClientPreservesMachineReadableAPIErrorCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"Authoritative report comparison facts are inconsistent.","errorCode":"facts-inconsistent"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get(context.Background(), "/api/reports/report/result")
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != http.StatusConflict || apiErr.Code != "facts-inconsistent" {
		t.Fatalf("expected preserved facts-inconsistent API error, got %#v", err)
	}
}
