package oauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	ProductionOrigin    = "https://signal.blyzr.com"
	ClientID            = ProductionOrigin + "/cli"
	Resource            = ProductionOrigin + "/api"
	defaultLoginTimeout = 5 * time.Minute
	maxOAuthBody        = 1 << 20
)

var requestedScopes = []string{"offline_access", "reports:read", "reports:create"}

type BrowserOpener func(string) error
type URLAnnouncer func(string)

type Manager struct {
	store        Store
	httpClient   *http.Client
	openBrowser  BrowserOpener
	now          func() time.Time
	loginTimeout time.Duration
	mu           sync.Mutex
}

func NewManager(store Store, timeout time.Duration) *Manager {
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	return &Manager{
		store: store,
		httpClient: &http.Client{
			Timeout:       timeout,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
		},
		openBrowser:  OpenBrowser,
		now:          time.Now,
		loginTimeout: defaultLoginTimeout,
	}
}

func randomURLToken(bytes int) (string, error) {
	value := make([]byte, bytes)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate OAuth entropy: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func normalizedOAuthIssuer(value string) (string, error) {
	issuer, err := normalizeIssuer(value)
	if err != nil {
		return "", err
	}
	parsed, _ := url.Parse(issuer)
	if parsed.Scheme != "https" && !(parsed.Scheme == "http" && isLoopback(parsed.Hostname())) {
		return "", fmt.Errorf("browser login requires HTTPS")
	}
	return issuer, nil
}

func isLoopback(host string) bool {
	ip := net.ParseIP(strings.TrimSuffix(strings.ToLower(host), "."))
	return strings.EqualFold(host, "localhost") || ip != nil && ip.IsLoopback()
}

type callbackResult struct {
	code string
	err  error
}

func callbackHTML(success bool) string {
	if success {
		return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Market Signal CLI connected</title><body style='font-family:system-ui;background:#06150f;color:#eaf9f0;padding:48px'><h1>Market Signal CLI is connected.</h1><p>You can close this tab and return to your terminal.</p></body>"
	}
	return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><title>Market Signal CLI login failed</title><body style='font-family:system-ui;background:#06150f;color:#eaf9f0;padding:48px'><h1>Login could not be completed.</h1><p>Return to your terminal and try again.</p></body>"
}

func (m *Manager) Login(ctx context.Context, rawIssuer string, announce URLAnnouncer) error {
	issuer, err := normalizedOAuthIssuer(rawIssuer)
	if err != nil {
		return err
	}
	state, err := randomURLToken(32)
	if err != nil {
		return err
	}
	verifier, err := randomURLToken(32)
	if err != nil {
		return err
	}
	challengeBytes := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeBytes[:])

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("start browser callback listener: %w", err)
	}
	defer listener.Close()
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok || address.Port <= 0 {
		return fmt.Errorf("browser callback listener has an invalid address")
	}
	redirectURI := fmt.Sprintf("http://127.0.0.1:%d/callback", address.Port)
	callback := make(chan callbackResult, 1)
	var accepted sync.Once
	mux := http.NewServeMux()
	mux.HandleFunc("/callback", func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if request.Method != http.MethodGet || subtle.ConstantTimeCompare([]byte(request.URL.Query().Get("state")), []byte(state)) != 1 || request.URL.Query().Get("iss") != issuer {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, callbackHTML(false))
			return
		}
		success := false
		accepted.Do(func() {
			if oauthError := strings.TrimSpace(request.URL.Query().Get("error")); oauthError != "" {
				callback <- callbackResult{err: fmt.Errorf("authorization was denied or failed: %s", oauthError)}
				return
			}
			code := strings.TrimSpace(request.URL.Query().Get("code"))
			if code == "" || len(code) > 4096 {
				callback <- callbackResult{err: fmt.Errorf("authorization server returned an invalid code")}
				return
			}
			success = true
			callback <- callbackResult{code: code}
		})
		if !success {
			w.WriteHeader(http.StatusBadRequest)
		}
		_, _ = io.WriteString(w, callbackHTML(success))
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second}
	serveDone := make(chan struct{})
	go func() {
		_ = server.Serve(listener)
		close(serveDone)
	}()
	defer func() {
		shutdown, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
		<-serveDone
	}()

	authorizeURL, _ := url.Parse(issuer + "/api/auth/oauth2/authorize")
	query := authorizeURL.Query()
	query.Set("client_id", ClientID)
	query.Set("redirect_uri", redirectURI)
	query.Set("response_type", "code")
	query.Set("scope", strings.Join(requestedScopes, " "))
	query.Set("state", state)
	query.Set("code_challenge", challenge)
	query.Set("code_challenge_method", "S256")
	query.Set("resource", Resource)
	query.Set("prompt", "consent")
	authorizeURL.RawQuery = query.Encode()
	if announce != nil {
		announce(authorizeURL.String())
	}
	if m.openBrowser != nil {
		_ = m.openBrowser(authorizeURL.String())
	}

	waitContext, cancel := context.WithTimeout(ctx, m.loginTimeout)
	defer cancel()
	var result callbackResult
	select {
	case <-waitContext.Done():
		return fmt.Errorf("browser login timed out: %w", waitContext.Err())
	case result = <-callback:
	}
	if result.err != nil {
		return result.err
	}
	tokens, err := m.exchange(ctx, issuer, url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {ClientID},
		"code":          {result.code},
		"code_verifier": {verifier},
		"redirect_uri":  {redirectURI},
		"resource":      {Resource},
	})
	if err != nil {
		return err
	}
	return m.store.Save(Credential{
		Issuer:               issuer,
		Kind:                 credentialOAuth,
		AccessToken:          tokens.AccessToken,
		AccessTokenExpiresAt: m.now().Add(time.Duration(tokens.ExpiresIn) * time.Second),
		RefreshToken:         tokens.RefreshToken,
	})
}

func (m *Manager) LoginWithAPIKey(rawIssuer, apiKey string) error {
	issuer, err := normalizedOAuthIssuer(rawIssuer)
	if err != nil {
		return err
	}
	credential := Credential{
		Issuer: issuer,
		Kind:   credentialAPIKey,
		APIKey: strings.TrimSpace(apiKey),
	}
	if err := validCredential(credential); err != nil {
		return err
	}
	return m.store.Save(credential)
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int64  `json:"expires_in"`
	Scope        string `json:"scope"`
}

func (m *Manager) exchange(ctx context.Context, issuer string, values url.Values) (tokenResponse, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, issuer+"/api/auth/oauth2/token", strings.NewReader(values.Encode()))
	if err != nil {
		return tokenResponse{}, fmt.Errorf("create token request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", "MarketSignalCLI/0.2")
	response, err := m.httpClient.Do(request)
	if err != nil {
		return tokenResponse{}, fmt.Errorf("request OAuth token: %w", err)
	}
	defer response.Body.Close()
	data, readErr := io.ReadAll(io.LimitReader(response.Body, maxOAuthBody+1))
	if readErr != nil || len(data) > maxOAuthBody {
		return tokenResponse{}, fmt.Errorf("read OAuth token response")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var body struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		_ = json.Unmarshal(data, &body)
		message := strings.TrimSpace(body.ErrorDescription)
		if message == "" {
			message = strings.TrimSpace(body.Error)
		}
		if message == "" {
			message = "authorization server rejected the token request"
		}
		return tokenResponse{}, fmt.Errorf("OAuth token request failed: %s", message)
	}
	var tokens tokenResponse
	if json.Unmarshal(data, &tokens) != nil || !strings.EqualFold(tokens.TokenType, "Bearer") || tokens.AccessToken == "" || tokens.RefreshToken == "" || tokens.ExpiresIn <= 0 || tokens.ExpiresIn > 24*60*60 {
		return tokenResponse{}, fmt.Errorf("authorization server returned an invalid token response")
	}
	granted := strings.Fields(tokens.Scope)
	if len(granted) > 0 {
		available := make(map[string]bool, len(granted))
		for _, scope := range granted {
			available[scope] = true
		}
		for _, scope := range requestedScopes {
			if !available[scope] {
				return tokenResponse{}, fmt.Errorf("authorization server omitted the required %s scope", scope)
			}
		}
	}
	return tokens, nil
}

func (m *Manager) AccessToken(ctx context.Context, rawIssuer string) (string, error) {
	issuer, err := normalizedOAuthIssuer(rawIssuer)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	credential, err := m.store.Load(issuer)
	if err != nil {
		if errors.Is(err, ErrNotLoggedIn) {
			return "", fmt.Errorf("not logged in; run marketsignal login")
		}
		return "", err
	}
	if credential.isAPIKey() {
		return credential.APIKey, nil
	}
	if m.now().Add(60 * time.Second).Before(credential.AccessTokenExpiresAt) {
		return credential.AccessToken, nil
	}
	tokens, err := m.exchange(ctx, issuer, url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {ClientID},
		"refresh_token": {credential.RefreshToken},
		"resource":      {Resource},
	})
	if err != nil {
		return "", fmt.Errorf("refresh login failed; run marketsignal login again: %w", err)
	}
	next := Credential{
		Issuer:               issuer,
		Kind:                 credentialOAuth,
		AccessToken:          tokens.AccessToken,
		AccessTokenExpiresAt: m.now().Add(time.Duration(tokens.ExpiresIn) * time.Second),
		RefreshToken:         tokens.RefreshToken,
	}
	if err := m.store.Save(next); err != nil {
		return "", fmt.Errorf("save rotated login: %w", err)
	}
	return next.AccessToken, nil
}

func (m *Manager) Logout(ctx context.Context, rawIssuer string) error {
	issuer, err := normalizedOAuthIssuer(rawIssuer)
	if err != nil {
		return err
	}
	credential, err := m.store.Load(issuer)
	if err != nil {
		return err
	}
	if credential.isAPIKey() {
		request, err := http.NewRequestWithContext(ctx, http.MethodDelete, issuer+"/api/cli/api-key", nil)
		if err != nil {
			return fmt.Errorf("create API key logout request: %w", err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("Authorization", "Bearer "+credential.APIKey)
		request.Header.Set("User-Agent", "MarketSignalCLI/0.2")
		response, err := m.httpClient.Do(request)
		if err != nil {
			return fmt.Errorf("revoke saved API key: %w", err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxOAuthBody))
		if response.StatusCode != http.StatusUnauthorized && (response.StatusCode < 200 || response.StatusCode >= 300) {
			return fmt.Errorf("server rejected API key logout with HTTP %d", response.StatusCode)
		}
		return m.store.Delete(issuer)
	}
	values := url.Values{
		"client_id":       {ClientID},
		"token":           {credential.RefreshToken},
		"token_type_hint": {"refresh_token"},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, issuer+"/api/auth/oauth2/revoke", strings.NewReader(values.Encode()))
	if err != nil {
		return fmt.Errorf("create logout request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("User-Agent", "MarketSignalCLI/0.2")
	response, err := m.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("revoke saved login: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxOAuthBody))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("authorization server rejected logout with HTTP %d", response.StatusCode)
	}
	return m.store.Delete(issuer)
}

func OpenBrowser(target string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", target)
	case "darwin":
		command = exec.Command("open", target)
	default:
		command = exec.Command("xdg-open", target)
	}
	if err := command.Start(); err != nil {
		return fmt.Errorf("open browser: %w", err)
	}
	return nil
}
