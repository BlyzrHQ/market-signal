package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type memoryStore struct {
	mu         sync.Mutex
	credential Credential
	present    bool
}

func (s *memoryStore) Load(issuer string) (Credential, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.present || s.credential.Issuer != issuer {
		return Credential{}, ErrNotLoggedIn
	}
	return s.credential, nil
}

func (s *memoryStore) Save(credential Credential) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.credential = credential
	s.present = true
	return nil
}

func (s *memoryStore) Delete(issuer string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.present || s.credential.Issuer != issuer {
		return ErrNotLoggedIn
	}
	s.credential = Credential{}
	s.present = false
	return nil
}

func TestBrowserLoginUsesPKCELoopbackAndSavesRotatingCredentials(t *testing.T) {
	store := &memoryStore{}
	var challenge string
	var announced string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/auth/oauth2/token" {
			http.NotFound(writer, request)
			return
		}
		if err := request.ParseForm(); err != nil {
			t.Errorf("parse token exchange: %v", err)
		}
		verifier := request.Form.Get("code_verifier")
		digest := sha256.Sum256([]byte(verifier))
		if base64.RawURLEncoding.EncodeToString(digest[:]) != challenge {
			t.Error("token exchange did not use the authorization request's PKCE verifier")
		}
		if request.Form.Get("grant_type") != "authorization_code" || request.Form.Get("client_id") != ClientID || request.Form.Get("resource") != Resource || request.Form.Get("code") != "one-time-code" {
			t.Errorf("unexpected token exchange: %#v", request.Form)
		}
		redirect, err := url.Parse(request.Form.Get("redirect_uri"))
		if err != nil || redirect.Scheme != "http" || redirect.Hostname() != "127.0.0.1" || redirect.Port() == "" || redirect.Path != "/callback" {
			t.Errorf("unexpected loopback redirect: %q", request.Form.Get("redirect_uri"))
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"access_token":  "access-token-one",
			"refresh_token": "refresh-token-one",
			"token_type":    "Bearer",
			"expires_in":    600,
			"scope":         strings.Join(requestedScopes, " "),
		})
	}))
	defer server.Close()

	manager := NewManager(store, time.Second)
	manager.openBrowser = func(target string) error {
		authorize, err := url.Parse(target)
		if err != nil {
			return err
		}
		query := authorize.Query()
		challenge = query.Get("code_challenge")
		if authorize.Scheme+"://"+authorize.Host != server.URL || authorize.Path != "/api/auth/oauth2/authorize" || query.Get("client_id") != ClientID || query.Get("resource") != Resource || query.Get("code_challenge_method") != "S256" || query.Get("response_type") != "code" || query.Get("scope") != strings.Join(requestedScopes, " ") {
			t.Errorf("unexpected authorization request: %s", target)
		}
		callback, err := url.Parse(query.Get("redirect_uri"))
		if err != nil {
			return err
		}
		values := callback.Query()
		values.Set("state", query.Get("state"))
		values.Set("iss", server.URL)
		values.Set("code", "one-time-code")
		callback.RawQuery = values.Encode()
		response, err := http.Get(callback.String())
		if err != nil {
			return err
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "CLI is connected") {
			t.Errorf("unexpected callback response: %d %s", response.StatusCode, body)
		}
		return nil
	}
	fixedNow := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	manager.now = func() time.Time { return fixedNow }
	if err := manager.Login(context.Background(), server.URL, func(target string) { announced = target }); err != nil {
		t.Fatal(err)
	}
	if announced == "" {
		t.Fatal("login must always print a fallback authorization URL")
	}
	credential, err := store.Load(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if credential.AccessToken != "access-token-one" || credential.RefreshToken != "refresh-token-one" || !credential.AccessTokenExpiresAt.Equal(fixedNow.Add(10*time.Minute)) {
		t.Fatalf("unexpected saved credential: %#v", credential)
	}
}

func TestAPIKeyLoginUsesStaticCredentialAndSelfRevokesBeforeDeletion(t *testing.T) {
	const apiKey = "msk_live_abcdefghijklmnop_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"
	store := &memoryStore{}
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodDelete || request.URL.Path != "/api/cli/api-key" {
			http.NotFound(writer, request)
			return
		}
		authorization = request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true,"revoked":true}`))
	}))
	defer server.Close()

	manager := NewManager(store, time.Second)
	if err := manager.LoginWithAPIKey(server.URL, apiKey); err != nil {
		t.Fatal(err)
	}
	token, err := manager.AccessToken(context.Background(), server.URL)
	if err != nil || token != apiKey {
		t.Fatalf("expected saved API key, token=%q err=%v", token, err)
	}
	if !store.credential.isAPIKey() || store.credential.AccessToken != "" || store.credential.RefreshToken != "" {
		t.Fatalf("unexpected API key credential: %#v", store.credential)
	}
	if err := manager.Logout(context.Background(), server.URL); err != nil {
		t.Fatal(err)
	}
	if authorization != "Bearer "+apiKey {
		t.Fatalf("self-revoke did not use the exact API key: %q", authorization)
	}
	if store.present {
		t.Fatal("API key credential remained after successful self-revocation")
	}
}

func TestAPIKeyLoginRejectsMalformedKeysWithoutSaving(t *testing.T) {
	store := &memoryStore{}
	manager := NewManager(store, time.Second)
	if err := manager.LoginWithAPIKey(ProductionOrigin, "not-a-market-signal-key"); err == nil || !strings.Contains(err.Error(), "API key is invalid") {
		t.Fatalf("expected invalid API key error, got %v", err)
	}
	if store.present {
		t.Fatal("malformed API key was saved")
	}
}

func TestBrowserLoginRendersFailureAndNeverExchangesDeniedAuthorization(t *testing.T) {
	store := &memoryStore{}
	var exchanges int
	var callbackStatus int
	var callbackBody string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		exchanges++
		http.Error(writer, "must not exchange", http.StatusInternalServerError)
	}))
	defer server.Close()

	manager := NewManager(store, time.Second)
	manager.openBrowser = func(target string) error {
		authorize, _ := url.Parse(target)
		callback, _ := url.Parse(authorize.Query().Get("redirect_uri"))
		values := callback.Query()
		values.Set("state", authorize.Query().Get("state"))
		values.Set("iss", server.URL)
		values.Set("error", "access_denied")
		callback.RawQuery = values.Encode()
		response, err := http.Get(callback.String())
		if err != nil {
			return err
		}
		defer response.Body.Close()
		body, _ := io.ReadAll(response.Body)
		callbackStatus = response.StatusCode
		callbackBody = string(body)
		return nil
	}
	err := manager.Login(context.Background(), server.URL, nil)
	if err == nil || !strings.Contains(err.Error(), "access_denied") {
		t.Fatalf("expected denied authorization, got %v", err)
	}
	if callbackStatus != http.StatusBadRequest || !strings.Contains(callbackBody, "Login could not be completed") {
		t.Fatalf("unexpected denial page: %d %s", callbackStatus, callbackBody)
	}
	if exchanges != 0 || store.present {
		t.Fatalf("denied login must not exchange or save credentials; exchanges=%d saved=%v", exchanges, store.present)
	}
}

func TestBrowserLoginRejectsMismatchedStateAndIssuerCallbacks(t *testing.T) {
	for _, mismatch := range []string{"state", "issuer"} {
		t.Run(mismatch, func(t *testing.T) {
			store := &memoryStore{}
			var exchanges int
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
				exchanges++
				http.Error(writer, "must not exchange", http.StatusInternalServerError)
			}))
			defer server.Close()

			manager := NewManager(store, time.Second)
			manager.loginTimeout = 30 * time.Millisecond
			manager.openBrowser = func(target string) error {
				authorize, _ := url.Parse(target)
				callback, _ := url.Parse(authorize.Query().Get("redirect_uri"))
				values := callback.Query()
				values.Set("state", authorize.Query().Get("state"))
				values.Set("iss", server.URL)
				values.Set("code", "must-not-exchange")
				if mismatch == "state" {
					values.Set("state", "wrong-state")
				} else {
					values.Set("iss", "https://wrong-issuer.example")
				}
				callback.RawQuery = values.Encode()
				response, err := http.Get(callback.String())
				if err != nil {
					return err
				}
				defer response.Body.Close()
				body, _ := io.ReadAll(response.Body)
				if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(body), "Login could not be completed") {
					t.Errorf("unexpected rejected callback response: %d %s", response.StatusCode, body)
				}
				return nil
			}

			err := manager.Login(context.Background(), server.URL, nil)
			if err == nil || !strings.Contains(err.Error(), "timed out") {
				t.Fatalf("expected rejected callback to leave login waiting for a valid callback, got %v", err)
			}
			if exchanges != 0 || store.present {
				t.Fatalf("mismatched callback must not exchange or save credentials; exchanges=%d saved=%v", exchanges, store.present)
			}
		})
	}
}

func TestBrowserLoginTimesOutWithoutACallback(t *testing.T) {
	manager := NewManager(&memoryStore{}, time.Second)
	manager.loginTimeout = 20 * time.Millisecond
	manager.openBrowser = func(string) error { return nil }
	err := manager.Login(context.Background(), "http://127.0.0.1:9876", nil)
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected bounded callback timeout, got %v", err)
	}
}

func TestAccessTokenRefreshesOnceAndPersistsTheRotatedToken(t *testing.T) {
	fixedNow := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	store := &memoryStore{present: true}
	var refreshes int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		refreshes++
		if err := request.ParseForm(); err != nil {
			t.Errorf("parse refresh request: %v", err)
			return
		}
		if request.Form.Get("grant_type") != "refresh_token" || request.Form.Get("refresh_token") != "refresh-token-old" || request.Form.Get("client_id") != ClientID || request.Form.Get("resource") != Resource {
			t.Errorf("unexpected refresh request: %#v", request.Form)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"access_token":"access-token-new","refresh_token":"refresh-token-new","token_type":"Bearer","expires_in":600,"scope":"offline_access reports:read reports:create"}`)
	}))
	defer server.Close()
	store.credential = Credential{Issuer: server.URL, AccessToken: "access-token-old", RefreshToken: "refresh-token-old", AccessTokenExpiresAt: fixedNow.Add(30 * time.Second)}

	manager := NewManager(store, time.Second)
	manager.now = func() time.Time { return fixedNow }
	first, err := manager.AccessToken(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.AccessToken(context.Background(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	if first != "access-token-new" || second != "access-token-new" || refreshes != 1 {
		t.Fatalf("expected one rotation and cached access token; first=%q second=%q refreshes=%d", first, second, refreshes)
	}
	if store.credential.RefreshToken != "refresh-token-new" {
		t.Fatal("rotated refresh token was not persisted")
	}
}

func TestLogoutRevokesBeforeDeletingTheLocalCredential(t *testing.T) {
	store := &memoryStore{present: true}
	var revoked bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if err := request.ParseForm(); err != nil {
			t.Errorf("parse revoke request: %v", err)
			return
		}
		revoked = request.URL.Path == "/api/auth/oauth2/revoke" && request.Form.Get("client_id") == ClientID && request.Form.Get("token") == "refresh-token" && request.Form.Get("token_type_hint") == "refresh_token"
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	store.credential = Credential{Issuer: server.URL, AccessToken: "access-token", RefreshToken: "refresh-token", AccessTokenExpiresAt: time.Now().Add(time.Minute)}

	manager := NewManager(store, time.Second)
	if err := manager.Logout(context.Background(), server.URL); err != nil {
		t.Fatal(err)
	}
	if !revoked || store.present {
		t.Fatalf("logout must revoke remotely before deleting locally; revoked=%v saved=%v", revoked, store.present)
	}
}

func TestHostedOAuthRejectsInsecureRemoteOrigins(t *testing.T) {
	manager := NewManager(&memoryStore{}, time.Second)
	if err := manager.Login(context.Background(), "http://example.com", nil); err == nil || !strings.Contains(err.Error(), "requires HTTPS") {
		t.Fatalf("expected insecure issuer rejection, got %v", err)
	}
	_, err := manager.AccessToken(context.Background(), "http://example.com")
	if err == nil || !strings.Contains(err.Error(), "requires HTTPS") {
		t.Fatalf("expected insecure token origin rejection, got %v", err)
	}
	if err := manager.Logout(context.Background(), "http://example.com"); err == nil || !strings.Contains(err.Error(), "requires HTTPS") {
		t.Fatalf("expected insecure logout origin rejection, got %v", err)
	}
	_, err = (&memoryStore{}).Load(ProductionOrigin)
	if !errors.Is(err, ErrNotLoggedIn) {
		t.Fatal("memory test store must preserve ErrNotLoggedIn semantics")
	}
}
