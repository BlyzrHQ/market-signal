package cmd

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testPublicReportID = "0123456789abcdef0123456789abcdef"
	testRequestID      = "orchestrator:babanuj:001"
	testLoopToken      = "loop-test-token-12345678901234567890"
)

func terminalLoopFixture(status string, delivered int) []byte {
	rows := make([]map[string]any, delivered)
	for index := range rows {
		rows[index] = map[string]any{
			"key":     fmt.Sprintf("match-%02d", index+1),
			"primary": map[string]any{"name": fmt.Sprintf("Babanuj product %d", index+1), "domain": "babanuj.com", "priceSignals": []any{map[string]any{"raw": "$10.00", "currency": "USD", "amount": 10}}},
			"rival":   map[string]any{"name": fmt.Sprintf("Rival product %d", index+1), "domain": "rival.example", "priceSignals": []any{map[string]any{"raw": "$9.00", "currency": "USD", "amount": 9}}},
			"match":   map[string]any{"assessment": map[string]any{"verdict": "same_product", "confidence": 0.94}, "decision": map[string]any{"recommendedMove": "Review the verified price gap."}},
		}
	}
	limitations := []string{}
	limitedPhases := []string{}
	if status == "limited" {
		limitations = []string{"The loop found fewer priced comparisons than the plan target."}
		limitedPhases = []string{"matching"}
	}
	payload := map[string]any{
		"state": "terminal",
		"output": map[string]any{
			"contractVersion": "1", "functionId": "market-signal.report", "functionVersion": "1",
			"requestId": testRequestID, "primaryDomain": "babanuj.com", "productPlan": "starter", "runId": "run_babanuj_001", "status": status,
			"report": map[string]any{"publicId": testPublicReportID, "ownerPath": "/reports/" + testPublicReportID, "status": status, "completedPhases": []string{"crawl", "products", "persistence"}, "limitedPhases": limitedPhases},
			"artifacts": []any{
				map[string]any{"kind": "report", "schemaVersion": "1", "reference": "market-signal:report:" + testPublicReportID, "contentHash": strings.Repeat("a", 64), "mediaType": "application/json", "recordCount": 1},
				map[string]any{"kind": "comparisons", "schemaVersion": "1", "reference": "market-signal:comparisons:" + testPublicReportID, "contentHash": strings.Repeat("b", 64), "mediaType": "application/json", "recordCount": delivered},
			},
			"metrics":    map[string]any{"comparisonTarget": 20, "publishedComparisons": delivered, "pricedComparisons": delivered, "competitorCount": 1, "repairRounds": 1, "usageStatus": "unknown", "costMicrousd": nil, "durationMs": 92000},
			"evaluation": map[string]any{"status": "unavailable", "evaluationId": nil, "evaluatorVersion": nil, "resultHash": nil},
			"failure":    nil,
			"startedAt":  "2026-09-02T10:00:00.000Z", "finishedAt": "2026-09-02T10:01:32.000Z",
		},
		"decision": map[string]any{
			"headline":           fmt.Sprintf("Babanuj returned %d priced product comparisons.", delivered),
			"coverage":           map[string]any{"target": 20, "delivered": delivered, "percent": float64(delivered) / 20 * 100},
			"competitorDomains":  []string{"rival.example"},
			"limitations":        limitations,
			"recommendedActions": []string{"Review the largest verified price gaps first."},
		},
		"comparisons": map[string]any{"inline": rows, "totalCount": delivered, "manifestHash": strings.Repeat("b", 64), "nextCursor": nil, "pageUrl": "/api/reports/" + testPublicReportID + "/matches"},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return data
}

func pendingLoopFixture() []byte {
	payload := map[string]any{
		"state": "pending", "requestId": testRequestID, "publicReportId": testPublicReportID,
		"primaryDomain": "babanuj.com", "status": "running", "phase": "matching", "attempt": 1,
		"heartbeatAt": "2026-09-02T10:00:30.000Z", "pollAfterSeconds": 1,
	}
	data, _ := json.Marshal(payload)
	return data
}

func submissionFixture() []byte {
	payload := map[string]any{
		"ok": true, "requestId": testRequestID, "replayed": false,
		"report": map[string]any{"publicId": testPublicReportID, "primaryDomain": "babanuj.com", "locale": "en", "status": "queued", "currentPhase": "queued", "attemptCount": 1, "createdAt": "2026-09-02T10:00:00.000Z", "expiresAt": "2026-10-02T10:00:00.000Z", "productPlan": "starter", "productLimit": 20, "productTargetKind": "pairs"},
		"job":    map[string]any{"dispatched": true, "runId": "run_babanuj_001"},
	}
	data, _ := json.Marshal(payload)
	return data
}

func replayedSubmissionFixture() []byte {
	var payload map[string]any
	_ = json.Unmarshal(submissionFixture(), &payload)
	payload["replayed"] = true
	payload["job"] = map[string]any{"dispatched": false, "runId": ""}
	data, _ := json.Marshal(payload)
	return data
}

func recoveredReplaySubmissionFixture() []byte {
	var payload map[string]any
	_ = json.Unmarshal(submissionFixture(), &payload)
	payload["replayed"] = true
	payload["job"] = map[string]any{"dispatched": true, "runId": "run_recovered1"}
	data, _ := json.Marshal(payload)
	return data
}

func terminalReplaySubmissionFixture() []byte {
	var payload map[string]any
	_ = json.Unmarshal(replayedSubmissionFixture(), &payload)
	report := payload["report"].(map[string]any)
	report["status"] = "complete"
	report["currentPhase"] = "complete"
	data, _ := json.Marshal(payload)
	return data
}

func failedLoopFixture(status string) []byte {
	payload := map[string]any{
		"state": "terminal",
		"output": map[string]any{
			"contractVersion": "1", "functionId": "market-signal.report", "functionVersion": "1",
			"requestId": testRequestID, "primaryDomain": "babanuj.com", "productPlan": "starter", "runId": "run_babanuj_001", "status": status,
			"report": nil, "artifacts": []any{},
			"metrics":    map[string]any{"comparisonTarget": 20, "publishedComparisons": 0, "pricedComparisons": 0, "competitorCount": 0, "repairRounds": 0, "usageStatus": "unknown", "costMicrousd": nil, "durationMs": 92000},
			"evaluation": map[string]any{"status": "unavailable", "evaluationId": nil, "evaluatorVersion": nil, "resultHash": nil},
			"failure":    map[string]any{"code": "crawl-failed", "message": "The primary storefront could not be crawled."},
			"startedAt":  "2026-09-02T10:00:00.000Z", "finishedAt": "2026-09-02T10:01:32.000Z",
		},
		"decision": map[string]any{
			"headline":          "The primary storefront could not be crawled.",
			"coverage":          map[string]any{"target": 20, "delivered": 0, "percent": 0},
			"competitorDomains": []string{}, "limitations": []string{"The primary storefront could not be crawled."},
			"recommendedActions": []string{"Inspect the failure before submitting a new request id."},
		},
		"comparisons": map[string]any{"inline": []any{}, "totalCount": 0, "manifestHash": "", "nextCursor": nil, "pageUrl": "/api/reports/" + testPublicReportID + "/matches"},
	}
	data, _ := json.Marshal(payload)
	return data
}

func TestSubmitWaitAndResultCommandsUseDurableLoopContract(t *testing.T) {
	t.Setenv("MARKET_SIGNAL_API_TOKEN", testLoopToken)
	var resultReads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+testLoopToken {
			t.Errorf("missing controlled-deployment bearer token")
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/reports":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode submit body: %v", err)
			}
			if body["primaryDomain"] != "babanuj.com" || body["commandId"] != testRequestID {
				t.Errorf("unexpected submit body: %#v", body)
			}
			_, _ = writer.Write(submissionFixture())
		case request.Method == http.MethodGet && request.URL.Path == "/api/reports/"+testPublicReportID+"/result":
			if request.URL.Query().Get("requestId") != testRequestID {
				t.Errorf("request correlation id was not preserved")
			}
			if resultReads.Add(1) == 1 {
				_, _ = writer.Write(pendingLoopFixture())
				return
			}
			_, _ = writer.Write(terminalLoopFixture("complete", 20))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	var submitOut bytes.Buffer
	submit := NewRoot("test")
	submit.SetOut(&submitOut)
	submit.SetArgs([]string{"submit", "https://www.babanuj.com/", "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	if err := submit.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{`"requestId": "` + testRequestID + `"`, `"comparisonTarget": 20`, `"state": "pending"`} {
		if !strings.Contains(submitOut.String(), expected) {
			t.Fatalf("submission output missing %s:\n%s", expected, submitOut.String())
		}
	}
	t.Logf("SUBMIT OUTPUT\n%s", submitOut.String())

	var waitOut bytes.Buffer
	wait := NewRoot("test")
	wait.SetOut(&waitOut)
	wait.SetArgs([]string{"wait", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet", "--poll", "1ms", "--max-wait", "1200ms"})
	if err := wait.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(waitOut.String(), `"headline": "Babanuj returned 20 priced product comparisons."`) || !strings.Contains(waitOut.String(), `"costMicrousd": null`) {
		t.Fatalf("wait did not return the decision-ready terminal payload:\n%s", waitOut.String())
	}
	t.Logf("WAIT OUTPUT\n%s", waitOut.String())

	var resultOut bytes.Buffer
	result := NewRoot("test")
	result.SetOut(&resultOut)
	result.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--quiet"})
	if err := result.Execute(); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"Babanuj returned 20 priced product comparisons.", "20/20 priced comparisons", "Provider cost unknown", "Babanuj product 1", "Review the largest verified price gaps first."} {
		if !strings.Contains(resultOut.String(), expected) {
			t.Fatalf("human result missing %q:\n%s", expected, resultOut.String())
		}
	}
	t.Logf("RESULT OUTPUT\n%s", resultOut.String())
}

func TestSubmitAcceptsAnExactReplayWithoutClaimingAnotherDispatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(replayedSubmissionFixture())
	}))
	defer server.Close()
	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"submit", "babanuj.com", "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), `"replayed": true`) {
		t.Fatalf("replayed submission was not preserved: %s", stdout.String())
	}
}

func TestSubmitAcceptsIdempotentDispatchRecoveryAndReportsTerminalReplayState(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		payload  []byte
		expected string
	}{
		{name: "dispatch recovery", payload: recoveredReplaySubmissionFixture(), expected: `"state": "pending"`},
		{name: "terminal replay", payload: terminalReplaySubmissionFixture(), expected: `"state": "terminal"`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write(testCase.payload)
			}))
			defer server.Close()
			var stdout bytes.Buffer
			root := NewRoot("test")
			root.SetOut(&stdout)
			root.SetArgs([]string{"submit", "babanuj.com", "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
			if err := root.Execute(); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(stdout.String(), testCase.expected) || !strings.Contains(stdout.String(), `"replayed": true`) {
				t.Fatalf("replay submission state was not preserved: %s", stdout.String())
			}
		})
	}
}

func TestResultReturnsPendingExitCodeWithoutResubmitting(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("result must never submit work, got %s", request.Method)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(pendingLoopFixture())
	}))
	defer server.Close()

	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 6 {
		t.Fatalf("expected resumable pending exit 6, got %v", err)
	}
	if !strings.Contains(stdout.String(), `"state": "pending"`) {
		t.Fatalf("pending state was not emitted:\n%s", stdout.String())
	}
}

func TestWaitTimeoutEmitsLastPendingStateAndNeverSubmits(t *testing.T) {
	var reads atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet {
			t.Errorf("wait must never submit work, got %s", request.Method)
			return
		}
		reads.Add(1)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(pendingLoopFixture())
	}))
	defer server.Close()

	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetOut(&stdout)
	root.SetArgs([]string{"wait", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet", "--poll", "1ms", "--max-wait", "20ms"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 6 {
		t.Fatalf("expected timeout exit 6, got %v", err)
	}
	if reads.Load() != 1 || !strings.Contains(stdout.String(), `"state": "pending"`) {
		t.Fatalf("timeout must emit one resumable pending snapshot; reads=%d output=%s", reads.Load(), stdout.String())
	}
}

func TestWaitCancellationEmitsLastPendingState(t *testing.T) {
	served := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(pendingLoopFixture())
		select {
		case <-served:
		default:
			close(served)
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	var stdout bytes.Buffer
	root := NewRoot("test")
	root.SetContext(ctx)
	root.SetOut(&stdout)
	root.SetArgs([]string{"wait", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet", "--poll", "1ms", "--max-wait", "5s"})
	go func() {
		<-served
		time.Sleep(100 * time.Millisecond)
		cancel()
	}()
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 6 || !strings.Contains(stdout.String(), `"state": "pending"`) {
		t.Fatalf("cancellation must return exit 6 and the last pending state, got %v output=%s", err, stdout.String())
	}
}

func TestCancellationDuringResultRequestUsesResumableExitCode(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	root := NewRoot("test")
	root.SetContext(ctx)
	root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	go func() {
		<-started
		cancel()
	}()
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 6 {
		t.Fatalf("in-flight cancellation must return resumable exit 6, got %v", err)
	}
}

func TestLimitedAndContractDriftHaveDistinctExitCodes(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		payload  []byte
		exitCode int
	}{
		{name: "limited", payload: terminalLoopFixture("limited", 12), exitCode: 2},
		{name: "drift", payload: []byte(`{"state":"terminal","output":{"status":"complete"}}`), exitCode: 3},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write(testCase.payload)
			}))
			defer server.Close()
			root := NewRoot("test")
			root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
			err := root.Execute()
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != testCase.exitCode {
				t.Fatalf("expected exit %d, got %v", testCase.exitCode, err)
			}
		})
	}
}

func TestFailedAndOutcomeUnknownHaveDistinctExitCodes(t *testing.T) {
	for _, testCase := range []struct {
		status   string
		exitCode int
	}{
		{status: "failed", exitCode: 5},
		{status: "outcome_unknown", exitCode: 6},
	} {
		t.Run(testCase.status, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				_, _ = writer.Write(failedLoopFixture(testCase.status))
			}))
			defer server.Close()
			var stdout bytes.Buffer
			root := NewRoot("test")
			root.SetOut(&stdout)
			root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
			err := root.Execute()
			var exitErr *ExitError
			if !errors.As(err, &exitErr) || exitErr.Code != testCase.exitCode {
				t.Fatalf("expected exit %d, got %v", testCase.exitCode, err)
			}
		})
	}
}

func TestResultRejectsSchemaValidIdentityMismatch(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal(terminalLoopFixture("complete", 20), &payload); err != nil {
		t.Fatal(err)
	}
	payload["output"].(map[string]any)["requestId"] = "orchestrator:someone-else:001"
	data, _ := json.Marshal(payload)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(data)
	}))
	defer server.Close()
	root := NewRoot("test")
	root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 3 {
		t.Fatalf("expected semantic drift exit 3, got %v", err)
	}
}

func TestResultRejectsSchemaValidReportIdentityMismatch(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal(terminalLoopFixture("complete", 20), &payload); err != nil {
		t.Fatal(err)
	}
	output := payload["output"].(map[string]any)
	output["report"].(map[string]any)["publicId"] = strings.Repeat("f", 32)
	data, _ := json.Marshal(payload)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write(data)
	}))
	defer server.Close()
	root := NewRoot("test")
	root.SetArgs([]string{"result", testPublicReportID, "--request-id", testRequestID, "--base-url", server.URL, "--output", "json", "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 3 {
		t.Fatalf("expected report identity drift exit 3, got %v", err)
	}
}

func TestSubmitMapsQuotaRefusalToExitSeven(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusTooManyRequests)
		_, _ = writer.Write([]byte(`{"error":"report quota reached"}`))
	}))
	defer server.Close()
	root := NewRoot("test")
	root.SetArgs([]string{"submit", "babanuj.com", "--request-id", testRequestID, "--base-url", server.URL, "--quiet"})
	err := root.Execute()
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != 7 {
		t.Fatalf("expected quota exit 7, got %v", err)
	}
}
