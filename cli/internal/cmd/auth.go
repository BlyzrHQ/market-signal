package cmd

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/abdullabostani/market-signal/cli/internal/oauth"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

func requireHostedLoginOrigin(baseURL string) error {
	if strings.TrimRight(strings.TrimSpace(baseURL), "/") != oauth.ProductionOrigin {
		return fmt.Errorf("browser login is available only for %s", oauth.ProductionOrigin)
	}
	return nil
}

func newLoginCommand(opts *options) *cobra.Command {
	var useAPIKey bool
	command := &cobra.Command{
		Use:   "login",
		Short: "Sign in through your browser or save an API key",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := requireHostedLoginOrigin(opts.baseURL); err != nil {
				return err
			}
			if useAPIKey {
				apiKey, err := readAPIKey(command, opts.apiKey)
				if err != nil {
					return &ExitError{Code: 4, Err: err}
				}
				if err := opts.auth.LoginWithAPIKey(opts.baseURL, apiKey); err != nil {
					return &ExitError{Code: 4, Err: err}
				}
				fmt.Fprintln(opts.stdout, "API key saved in the operating-system credential store.")
				return nil
			}
			fmt.Fprintln(opts.stderr, "Opening Market Signal in your browser.")
			err := opts.auth.Login(command.Context(), opts.baseURL, func(target string) {
				fmt.Fprintf(opts.stderr, "If the browser does not open, visit:\n%s\n", target)
			})
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			fmt.Fprintln(opts.stdout, "Logged in to Market Signal.")
			return nil
		},
	}
	command.Flags().BoolVar(&useAPIKey, "api-key", false, "save a Market Signal API key instead of opening a browser")
	command.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
		if strings.Contains(err.Error(), "api-key") {
			return fmt.Errorf("use --api-key without a value; the CLI will prompt securely")
		}
		return err
	})
	return command
}

func readAPIKey(command *cobra.Command, environmentValue string) (string, error) {
	if value := strings.TrimSpace(environmentValue); value != "" {
		return value, nil
	}
	input := command.InOrStdin()
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		fmt.Fprint(command.ErrOrStderr(), "Paste your Market Signal API key: ")
		secret, err := term.ReadPassword(int(file.Fd()))
		fmt.Fprintln(command.ErrOrStderr())
		if err != nil {
			return "", fmt.Errorf("read API key: %w", err)
		}
		return strings.TrimSpace(string(secret)), nil
	}
	return "", fmt.Errorf("set MARKET_SIGNAL_API_KEY for non-interactive use, or run marketsignal login --api-key in a terminal")
}

func newLogoutCommand(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Remove this computer's saved login",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			if err := requireHostedLoginOrigin(opts.baseURL); err != nil {
				return err
			}
			err := opts.auth.Logout(command.Context(), opts.baseURL)
			if errors.Is(err, oauth.ErrNotLoggedIn) {
				fmt.Fprintln(opts.stdout, "Already logged out of Market Signal.")
				return nil
			}
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			fmt.Fprintln(opts.stdout, "Logged out of Market Signal.")
			return nil
		},
	}
}
