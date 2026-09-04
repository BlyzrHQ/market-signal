// Package triggercli speaks only to Trigger.dev. It does not use Market Signal
// website authentication, storage endpoints, or customer entitlements.
package triggercli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"
)

const origin = "https://api.trigger.dev"
const maxBody = 16 * 1024 * 1024

var keyPattern = regexp.MustCompile(`^tr_(dev|prod|stg)_[A-Za-z0-9_]{16,256}$`)
var runPattern = regexp.MustCompile(`^run_[A-Za-z0-9_-]{1,160}$`)
var requestPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$`)

type Client struct {
	base, key string
	http      *http.Client
}

func newClient(key string) (*Client, error) {
	if !keyPattern.MatchString(key) {
		return nil, fmt.Errorf("a private Trigger environment key is required; run configure")
	}
	return &Client{origin, key, &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}, nil
}

// Do not retry submissions or disclose response bodies/transport errors, which
// can contain credentials, URLs, provider messages, or arbitrary task output.
func (c *Client) call(ctx context.Context, method, path string, payload any, out any) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("cannot encode task input")
		}
		body = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return fmt.Errorf("invalid Trigger request")
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		if method == http.MethodPost {
			return fmt.Errorf("Trigger submission outcome unknown; inspect Trigger runs before retrying; do not create a new request ID")
		}
		return fmt.Errorf("Trigger request failed or interrupted")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		if method == http.MethodPost && res.StatusCode >= 500 {
			return fmt.Errorf("Trigger submission outcome unknown (HTTP %d); inspect runs before retrying", res.StatusCode)
		}
		return fmt.Errorf("Trigger returned HTTP %d (401/403: key access; 404: task/run not installed in this environment; 429: Trigger rate limit)", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil || len(data) > maxBody {
		return fmt.Errorf("Trigger response unreadable or over 16 MiB")
	}
	if out != nil && json.Unmarshal(data, out) != nil {
		return fmt.Errorf("Trigger returned invalid JSON")
	}
	return nil
}

func (c *Client) verify(ctx context.Context) error {
	var result struct {
		Data []json.RawMessage `json:"data"`
	}
	return c.call(ctx, http.MethodGet, "/api/v1/runs?page[size]=1", nil, &result)
}

type Run struct {
	ID      string          `json:"id"`
	Status  string          `json:"status"`
	Task    string          `json:"taskIdentifier"`
	Output  json.RawMessage `json:"output,omitempty"`
	Payload map[string]any  `json:"payload,omitempty"`
}

func (c *Client) trigger(ctx context.Context, task, id string, payload any) (string, error) {
	if !requestPattern.MatchString(id) {
		return "", fmt.Errorf("request ID must contain 1-120 letters, numbers, colons, underscores or hyphens")
	}
	var receipt struct {
		ID string `json:"id"`
	}
	err := c.call(ctx, http.MethodPost, "/api/v1/tasks/"+url.PathEscape(task)+"/trigger", map[string]any{"payload": payload, "options": map[string]any{"idempotencyKey": id, "idempotencyKeyTTL": "24h"}}, &receipt)
	if err != nil {
		return "", err
	}
	if !runPattern.MatchString(receipt.ID) {
		return "", fmt.Errorf("invalid Trigger receipt; submission outcome unknown; inspect runs before retrying")
	}
	return receipt.ID, nil
}

func (c *Client) retrieve(ctx context.Context, id string) (Run, error) {
	var result Run
	if !runPattern.MatchString(id) {
		return result, fmt.Errorf("enter a Trigger run ID")
	}
	err := c.call(ctx, http.MethodGet, "/api/v3/runs/"+url.PathEscape(id), nil, &result)
	if err == nil && (result.ID != id || !allowedTask(result.Task)) {
		err = fmt.Errorf("run is not a Market Signal direct task")
	}
	return result, err
}

func allowedTask(task string) bool {
	switch task {
	case "market-signal-direct-report", "market-signal-direct-compare", "market-signal-direct-crawl", "market-signal-direct-capabilities":
		return true
	}
	return false
}

func terminal(status string) bool {
	switch status {
	case "COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED":
		return true
	}
	return false
}
