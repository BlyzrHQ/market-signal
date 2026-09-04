package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/abdullabostani/market-signal/cli/internal/oauth"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

const maxInternalCredentialInput = 512

func newInternalConfigureCommand(opts *options) *cobra.Command {
	var fromStdin bool
	command := &cobra.Command{
		Use:   "configure",
		Short: "Provision the company credential on this machine",
		Args:  cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			origin := strings.TrimRight(strings.TrimSpace(opts.baseURL), "/")
			if origin != oauth.ProductionOrigin && !opts.allowInternalTestOrigin {
				return &ExitError{Code: 4, Err: fmt.Errorf("the internal credential can be stored only for %s", oauth.ProductionOrigin)}
			}
			apiKey, err := readInternalCredential(command, fromStdin)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			if err := opts.auth.LoginWithAPIKey(opts.baseURL, apiKey); err != nil {
				return &ExitError{Code: 4, Err: fmt.Errorf("save internal credential: %w", err)}
			}
			fmt.Fprintln(opts.stdout, "Internal Market Signal credential saved in the operating-system credential store.")
			return nil
		},
	}
	command.Flags().BoolVar(&fromStdin, "stdin", false, "read the one-time credential from standard input")
	return command
}

func readInternalCredential(command *cobra.Command, fromStdin bool) (string, error) {
	input := command.InOrStdin()
	if fromStdin {
		data, err := io.ReadAll(io.LimitReader(input, maxInternalCredentialInput+1))
		if err != nil || len(data) > maxInternalCredentialInput {
			return "", fmt.Errorf("read bounded internal credential")
		}
		value := strings.TrimSpace(string(data))
		if value == "" || strings.ContainsAny(value, "\r\n\t ") {
			return "", fmt.Errorf("internal credential input is invalid")
		}
		return value, nil
	}
	if file, ok := input.(*os.File); ok && term.IsTerminal(int(file.Fd())) {
		fmt.Fprint(command.ErrOrStderr(), "Paste the one-time internal Market Signal credential: ")
		secret, err := term.ReadPassword(int(file.Fd()))
		fmt.Fprintln(command.ErrOrStderr())
		if err != nil {
			return "", fmt.Errorf("read internal credential")
		}
		return strings.TrimSpace(string(secret)), nil
	}
	return "", fmt.Errorf("run configure in a terminal or pipe the one-time credential with --stdin")
}
