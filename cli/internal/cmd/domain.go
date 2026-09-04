package cmd

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

func canonicalDomain(input string) (string, error) {
	value := strings.TrimSpace(input)
	if value == "" {
		return "", fmt.Errorf("enter a public domain")
	}
	if strings.ContainsAny(value, "<>") {
		return "", fmt.Errorf("replace the domain placeholder with your public domain")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", fmt.Errorf("%q is not a public HTTP domain", input)
	}
	host := strings.TrimPrefix(strings.ToLower(parsed.Hostname()), "www.")
	if host == "localhost" {
		return "", fmt.Errorf("private or local domains cannot be analyzed")
	}
	if address := net.ParseIP(host); address != nil && (address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast() || address.IsUnspecified()) {
		return "", fmt.Errorf("private or local domains cannot be analyzed")
	}
	return host, nil
}
