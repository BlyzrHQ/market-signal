// Package triggercli speaks only to Trigger.dev. It does not use Market Signal
// website authentication, storage endpoints, or customer entitlements.
package triggercli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
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
	base, key     string
	workerVersion string
	http          *http.Client
	artifactHTTP  *http.Client
}

func newClient(key string) (*Client, error) {
	if !keyPattern.MatchString(key) {
		return nil, fmt.Errorf("a private Trigger environment key is required; run configure")
	}
	return &Client{base: origin, key: key, http: &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, artifactHTTP: artifactClient()}, nil
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
	ID                 string          `json:"id"`
	Status             string          `json:"status"`
	Task               string          `json:"taskIdentifier"`
	Version            string          `json:"version,omitempty"`
	Output             json.RawMessage `json:"output,omitempty"`
	Payload            map[string]any  `json:"payload,omitempty"`
	OutputPresignedURL string          `json:"outputPresignedUrl,omitempty"`
}

func (c *Client) trigger(ctx context.Context, task, id string, payload any) (string, error) {
	if !requestPattern.MatchString(id) {
		return "", fmt.Errorf("request ID must contain 1-120 letters, numbers, colons, underscores or hyphens")
	}
	var receipt struct {
		ID string `json:"id"`
	}
	options := map[string]any{"idempotencyKey": id, "idempotencyKeyTTL": "24h"}
	if c.workerVersion != "" {
		options["lockToVersion"] = c.workerVersion
	}
	err := c.call(ctx, http.MethodPost, "/api/v1/tasks/"+url.PathEscape(task)+"/trigger", map[string]any{"payload": payload, "options": options}, &receipt)
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
	if err == nil && c.workerVersion != "" && (result.Version != "" || terminal(result.Status)) && result.Version != c.workerVersion {
		err = fmt.Errorf("Trigger worker version does not match the requested pin; inspect this run, do not resubmit")
	}
	if err == nil && result.Status == "COMPLETED" && (len(result.Output) == 0 || string(result.Output) == "null") && result.OutputPresignedURL != "" {
		result.Output, err = c.downloadOutput(ctx, result.OutputPresignedURL)
	}
	result.OutputPresignedURL = "" // Never print a temporary access credential.
	return result, err
}

func publicArtifactIP(ip net.IP) bool {
	return ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified()
}
func artifactClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: &http.Transport{
		// No proxy or inherited bearer headers. Pin a verified public IP so
		// a subsequent DNS lookup cannot rebind this request to private services.
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, fmt.Errorf("invalid artifact address")
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, fmt.Errorf("artifact DNS failed")
			}
			for _, ip := range ips {
				if !publicArtifactIP(ip.IP) {
					return nil, fmt.Errorf("artifact address is not public")
				}
			}
			dialer := net.Dialer{Timeout: 15 * time.Second}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}}
}
func (c *Client) downloadOutput(ctx context.Context, rawURL string) (json.RawMessage, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Hostname() == "" || (u.Port() != "" && u.Port() != "443") || net.ParseIP(u.Hostname()) != nil {
		return nil, fmt.Errorf("invalid Trigger artifact URL")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("invalid artifact request")
	}
	// Deliberately no Authorization header, even for a Trigger-owned host.
	res, err := c.artifactHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Trigger artifact download failed; retry result with the same run ID")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Trigger artifact returned HTTP %d; retry result to refresh its signed URL", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxBody+1))
	if err != nil || len(data) > maxBody || !json.Valid(data) {
		return nil, fmt.Errorf("Trigger artifact is unreadable, invalid JSON, or over 16 MiB")
	}
	contentType, _, err := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if err != nil {
		return nil, fmt.Errorf("Trigger artifact has an unsupported content type")
	}
	switch contentType {
	case "application/json":
		return data, nil
	case "application/super+json":
		var packet struct {
			JSON json.RawMessage `json:"json"`
			Meta json.RawMessage `json:"meta"`
		}
		if json.Unmarshal(data, &packet) != nil || len(packet.JSON) == 0 || (len(packet.Meta) > 0 && string(packet.Meta) != "null" && string(packet.Meta) != "{}") {
			return nil, fmt.Errorf("Trigger artifact contains unsupported typed metadata; inspect worker output contract")
		}
		return packet.JSON, nil
	default:
		return nil, fmt.Errorf("Trigger artifact has an unsupported content type")
	}
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
	case "COMPLETED", "FAILED", "CANCELED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED", "INTERRUPTED":
		return true
	}
	return false
}
