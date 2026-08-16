package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxResponseBytes = 25 << 20

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	timeout    time.Duration
	token      string
}

type APIError struct {
	Status int
	Msg    string
}

func (e *APIError) Error() string {
	if e.Status == 0 {
		return e.Msg
	}
	return fmt.Sprintf("Market Signal API returned HTTP %d: %s", e.Status, e.Msg)
}

func NewClient(baseURL string, timeout time.Duration, tokens ...string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid base URL %q", baseURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("base URL must use HTTP or HTTPS")
	}
	token := ""
	if len(tokens) > 0 {
		token = strings.TrimSpace(tokens[0])
	}
	return &Client{
		baseURL: parsed,
		timeout: timeout,
		token:   token,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Post(ctx context.Context, path string, payload any) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode request: %w", err)
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: path}).String()

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "MarketSignalCLI/0.1")
		if c.token != "" {
			request.Header.Set("Authorization", "Bearer "+c.token)
		}

		response, err := c.httpClient.Do(request)
		if err != nil {
			lastErr = &APIError{Msg: "request failed: " + err.Error()}
			if attempt == 0 && ctx.Err() == nil {
				continue
			}
			return nil, lastErr
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		response.Body.Close()
		if readErr != nil {
			return nil, &APIError{Status: response.StatusCode, Msg: "could not read response"}
		}
		if len(data) > maxResponseBytes {
			return nil, &APIError{Status: response.StatusCode, Msg: "response exceeded 25 MiB limit"}
		}
		if isTransient(response.StatusCode) && attempt == 0 {
			lastErr = &APIError{Status: response.StatusCode, Msg: "transient server failure"}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, &APIError{Status: response.StatusCode, Msg: errorMessage(data)}
		}
		if !json.Valid(data) {
			contentType := response.Header.Get("Content-Type")
			if strings.Contains(contentType, "text/html") || bytes.HasPrefix(bytes.TrimSpace(data), []byte("<!DOCTYPE")) {
				return nil, &APIError{Status: response.StatusCode, Msg: "server returned HTML instead of JSON; the deployment may require browser sign-in or the API route may be unavailable"}
			}
			return nil, &APIError{Status: response.StatusCode, Msg: "server returned invalid JSON"}
		}
		return data, nil
	}
	return nil, lastErr
}

func isTransient(status int) bool {
	return status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func errorMessage(data []byte) string {
	var body struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(data, &body) == nil && strings.TrimSpace(body.Error) != "" {
		return body.Error
	}
	if bytes.HasPrefix(bytes.TrimSpace(data), []byte("<")) {
		return "server returned HTML instead of JSON; check the base URL and authentication"
	}
	return strings.TrimSpace(string(data))
}
