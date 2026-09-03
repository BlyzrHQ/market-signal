package oauth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/zalando/go-keyring"
)

const (
	keyringService     = "Market Signal CLI"
	maxCredentialBytes = 2400
	credentialOAuth    = "oauth"
	credentialAPIKey   = "api_key"
)

var ErrNotLoggedIn = errors.New("not logged in")

type Credential struct {
	Issuer               string    `json:"issuer"`
	Kind                 string    `json:"kind,omitempty"`
	AccessToken          string    `json:"accessToken"`
	AccessTokenExpiresAt time.Time `json:"accessTokenExpiresAt"`
	RefreshToken         string    `json:"refreshToken"`
	APIKey               string    `json:"apiKey,omitempty"`
}

var apiKeyPattern = regexp.MustCompile(`^msk_live_[A-Za-z0-9_-]{16}_[A-Za-z0-9_-]{43}$`)

func ValidHostedAPIKey(value string) bool {
	return apiKeyPattern.MatchString(strings.TrimSpace(value))
}

type Store interface {
	Load(issuer string) (Credential, error)
	Save(credential Credential) error
	Delete(issuer string) error
}

type KeyringStore struct{}

func NewKeyringStore() *KeyringStore { return &KeyringStore{} }

func normalizeIssuer(value string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("invalid credential issuer")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return "", fmt.Errorf("credential issuer must not contain a path")
	}
	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func legacyAccountName(issuer string) (string, error) {
	normalized, err := normalizeIssuer(issuer)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(normalized))
	return "origin-" + base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

func accountName(issuer, kind string) (string, error) {
	legacy, err := legacyAccountName(issuer)
	if err != nil {
		return "", err
	}
	if kind != credentialOAuth && kind != credentialAPIKey {
		return "", fmt.Errorf("invalid credential kind")
	}
	return kind + "-" + legacy, nil
}

func validCredential(credential Credential) error {
	issuer, err := normalizeIssuer(credential.Issuer)
	if err != nil || issuer != credential.Issuer {
		return fmt.Errorf("credential issuer is invalid")
	}
	kind := credential.Kind
	if kind == "" {
		kind = credentialOAuth
	}
	if kind == credentialAPIKey {
		if !ValidHostedAPIKey(credential.APIKey) || strings.ContainsAny(credential.APIKey, "\r\n\t ") {
			return fmt.Errorf("API key is invalid")
		}
		if credential.AccessToken != "" || credential.RefreshToken != "" || !credential.AccessTokenExpiresAt.IsZero() {
			return fmt.Errorf("API key credential contains OAuth tokens")
		}
		return nil
	}
	if kind != credentialOAuth || credential.APIKey != "" || credential.AccessToken == "" || credential.RefreshToken == "" || credential.AccessTokenExpiresAt.IsZero() {
		return fmt.Errorf("credential is incomplete")
	}
	if len(credential.AccessToken) > 16_384 || len(credential.RefreshToken) > 16_384 || strings.ContainsAny(credential.AccessToken+credential.RefreshToken, "\r\n\t ") {
		return fmt.Errorf("credential token is invalid")
	}
	return nil
}

func (credential Credential) isAPIKey() bool {
	return credential.Kind == credentialAPIKey
}

func (s *KeyringStore) Load(issuer string) (Credential, error) {
	normalized, _ := normalizeIssuer(issuer)
	accounts := make([]string, 0, 3)
	for _, kind := range []string{credentialAPIKey, credentialOAuth} {
		account, err := accountName(issuer, kind)
		if err != nil {
			return Credential{}, err
		}
		accounts = append(accounts, account)
	}
	legacy, err := legacyAccountName(issuer)
	if err != nil {
		return Credential{}, err
	}
	accounts = append(accounts, legacy)
	for _, account := range accounts {
		value, err := keyring.Get(keyringService, account)
		if errors.Is(err, keyring.ErrNotFound) {
			continue
		}
		if err != nil {
			return Credential{}, fmt.Errorf("read saved login: %w", err)
		}
		var credential Credential
		if json.Unmarshal([]byte(value), &credential) != nil || validCredential(credential) != nil {
			return Credential{}, fmt.Errorf("saved login is invalid; run marketsignal logout and login again")
		}
		if credential.Issuer != normalized {
			return Credential{}, fmt.Errorf("saved login belongs to a different service")
		}
		return credential, nil
	}
	return Credential{}, ErrNotLoggedIn
}

func (s *KeyringStore) Save(credential Credential) error {
	if credential.Kind == "" {
		credential.Kind = credentialOAuth
	}
	if err := validCredential(credential); err != nil {
		return err
	}
	data, err := json.Marshal(credential)
	if err != nil {
		return fmt.Errorf("encode saved login: %w", err)
	}
	if len(data) > maxCredentialBytes {
		return fmt.Errorf("saved login exceeds the operating-system credential limit")
	}
	account, err := accountName(credential.Issuer, credential.Kind)
	if err != nil {
		return err
	}
	if err := keyring.Set(keyringService, account, string(data)); err != nil {
		return fmt.Errorf("save login in the operating-system credential store: %w", err)
	}
	otherKind := credentialOAuth
	if credential.Kind == credentialOAuth {
		otherKind = credentialAPIKey
	}
	otherAccount, _ := accountName(credential.Issuer, otherKind)
	legacyAccount, _ := legacyAccountName(credential.Issuer)
	for _, staleAccount := range []string{otherAccount, legacyAccount} {
		if err := keyring.Delete(keyringService, staleAccount); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return fmt.Errorf("replace previous saved login: %w", err)
		}
	}
	return nil
}

func (s *KeyringStore) Delete(issuer string) error {
	legacy, err := legacyAccountName(issuer)
	if err != nil {
		return err
	}
	apiKeyAccount, _ := accountName(issuer, credentialAPIKey)
	oauthAccount, _ := accountName(issuer, credentialOAuth)
	removed := false
	for _, account := range []string{apiKeyAccount, oauthAccount, legacy} {
		err = keyring.Delete(keyringService, account)
		if errors.Is(err, keyring.ErrNotFound) {
			continue
		}
		if err != nil {
			return fmt.Errorf("delete saved login: %w", err)
		}
		removed = true
	}
	if !removed {
		return ErrNotLoggedIn
	}
	return nil
}
