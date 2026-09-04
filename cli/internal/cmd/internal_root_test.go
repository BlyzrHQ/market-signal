package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/abdullabostani/market-signal/cli/internal/oauth"
)

type memoryCredentialStore struct {
	credential oauth.Credential
}

func (store *memoryCredentialStore) Load(_ string) (oauth.Credential, error) {
	if store.credential.Issuer == "" {
		return oauth.Credential{}, oauth.ErrNotLoggedIn
	}
	return store.credential, nil
}

func (store *memoryCredentialStore) Save(credential oauth.Credential) error {
	store.credential = credential
	return nil
}

func (store *memoryCredentialStore) Delete(_ string) error {
	store.credential = oauth.Credential{}
	return nil
}

func internalTestManager(t *testing.T, issuer string) (*oauth.Manager, *memoryCredentialStore) {
	t.Helper()
	store := &memoryCredentialStore{}
	manager := oauth.NewManager(store, time.Second)
	if err := manager.LoginWithAPIKey(issuer, validHostedAPIKey); err != nil {
		t.Fatal(err)
	}
	return manager, store
}

func TestInternalReportDefaultsToTwentyComparisonsAndMachineReadableOutput(t *testing.T) {
	var posts int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+validHostedAPIKey {
			t.Errorf("internal workspace credential was not used")
		}
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/reports":
			posts++
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["primaryDomain"] != "babanuj.com" || body["commandId"] != testRequestID || body["comparisonTarget"] != float64(20) {
				t.Fatalf("unexpected internal report request: %#v", body)
			}
			_, _ = writer.Write(submissionFixture())
		case request.Method == http.MethodGet && request.URL.Path == "/api/reports/"+testPublicReportID+"/result":
			_, _ = writer.Write(terminalLoopFixture("complete", 20))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	manager, _ := internalTestManager(t, server.URL)
	var stdout, stderr bytes.Buffer
	root := newInternalRoot("test", manager, true)
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs([]string{"report", "babanuj.com", "--request-id", testRequestID, "--base-url", server.URL, "--poll", "1ms", "--max-wait", "1s"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if posts != 1 {
		t.Fatalf("internal report submitted %d times", posts)
	}
	for _, expected := range []string{`"state": "terminal"`, `"comparisonTarget": 20`, `"competitors"`, `"comparisons"`} {
		if !strings.Contains(stdout.String(), expected) {
			t.Fatalf("internal JSON output missing %s:\n%s", expected, stdout.String())
		}
	}
	if stderr.Len() != 0 {
		t.Fatalf("internal command should be quiet by default: %s", stderr.String())
	}
}

func TestInternalReportSelectsOnlyFixedComparisonTargets(t *testing.T) {
	root := newInternalRoot("test", nil, true)
	root.SetArgs([]string{"report", "babanuj.com", "--comparisons", "21", "--request-id", testRequestID})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "20, 50, 500, or 1000") {
		t.Fatalf("expected bounded comparison target error, got %v", err)
	}
}

func TestInternalReportRequiresCallerOwnedRequestIDBeforeAnyNetworkCall(t *testing.T) {
	root := newInternalRoot("test", nil, true)
	root.SetArgs([]string{"report", "babanuj.com"})
	err := root.Execute()
	if err == nil || !strings.Contains(err.Error(), "--request-id is required") {
		t.Fatalf("expected required idempotency key error, got %v", err)
	}
}

func TestInternalHelpExposesOnlyAgentWorkflowCommands(t *testing.T) {
	var stdout bytes.Buffer
	root := newInternalRoot("test", nil, true)
	root.SetOut(&stdout)
	root.SetArgs([]string{"--help"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	help := stdout.String()
	for _, visible := range []string{"report", "wait", "result", "version"} {
		if !strings.Contains(help, visible) {
			t.Fatalf("expected %q in internal help:\n%s", visible, help)
		}
	}
	for _, hidden := range []string{"\n  login ", "\n  logout ", "\n  crawl ", "\n  submit ", "\n  configure ", "--base-url", "--timeout"} {
		if strings.Contains(help, hidden) {
			t.Fatalf("customer or operator command %q leaked into internal help:\n%s", hidden, help)
		}
	}
}

func TestInternalConfigureImportsCredentialWithoutEchoingIt(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	store := &memoryCredentialStore{}
	manager := oauth.NewManager(store, time.Second)
	var stdout, stderr bytes.Buffer
	root := newInternalRoot("test", manager, true)
	root.SetIn(strings.NewReader(validHostedAPIKey + "\n"))
	root.SetOut(&stdout)
	root.SetErr(&stderr)
	root.SetArgs([]string{"configure", "--stdin", "--base-url", server.URL})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if store.credential.APIKey != validHostedAPIKey {
		t.Fatal("internal credential was not saved")
	}
	if strings.Contains(stdout.String()+stderr.String(), validHostedAPIKey) {
		t.Fatal("internal credential was echoed")
	}
}

func TestInternalCredentialCannotFollowAnOverriddenProductionOrigin(t *testing.T) {
	manager, _ := internalTestManager(t, oauth.ProductionOrigin)
	_, _, err := dependencies(&options{
		baseURL: "https://attacker.example", timeout: time.Second, output: "json",
		auth: manager, internal: true,
	})
	if err == nil || !strings.Contains(err.Error(), "can be sent only") {
		t.Fatalf("expected exact-origin rejection, got %v", err)
	}
}

func TestInternalMissingCredentialIsSanitized(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	manager := oauth.NewManager(&memoryCredentialStore{}, time.Second)
	root := newInternalRoot("test", manager, true)
	root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 4 || !strings.Contains(err.Error(), "not provisioned") {
		t.Fatalf("expected sanitized missing-credential error, got %v", err)
	}
}

func TestInternalReportMakesIdempotencyConflictNonRetryable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusConflict)
		_, _ = writer.Write([]byte(`{"ok":false,"error":"request id conflict","errorCode":"idempotency-conflict"}`))
	}))
	defer server.Close()
	manager, _ := internalTestManager(t, server.URL)
	root := newInternalRoot("test", manager, true)
	root.SetArgs([]string{"report", "babanuj.com", "--request-id", testRequestID, "--base-url", server.URL})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 9 {
		t.Fatalf("expected non-retryable request conflict exit 9, got %v", err)
	}
}

func TestInternalConfigureRejectsNonProductionIssuer(t *testing.T) {
	store := &memoryCredentialStore{}
	manager := oauth.NewManager(store, time.Second)
	root := newInternalRoot("test", manager, false)
	root.SetIn(strings.NewReader(validHostedAPIKey + "\n"))
	root.SetArgs([]string{"configure", "--stdin", "--base-url", "https://attacker.example"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 4 || !strings.Contains(err.Error(), "stored only") {
		t.Fatalf("expected production issuer rejection, got %v", err)
	}
	if store.credential.Issuer != "" {
		t.Fatal("credential was stored for a non-production issuer")
	}
}
