package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/abdullabostani/market-signal/cli/internal/api"
	"github.com/abdullabostani/market-signal/cli/internal/contract"
	"github.com/spf13/cobra"
)

type options struct {
	baseURL  string
	apiToken string
	timeout  time.Duration
	output   string
	quiet    bool
	stdout   io.Writer
	stderr   io.Writer
}

func NewRoot(version string) *cobra.Command {
	defaultBaseURL := strings.TrimSpace(os.Getenv("MARKET_SIGNAL_BASE_URL"))
	if defaultBaseURL == "" {
		defaultBaseURL = "http://localhost:3000"
	}
	opts := &options{baseURL: defaultBaseURL, apiToken: strings.TrimSpace(os.Getenv("MARKET_SIGNAL_API_TOKEN")), timeout: 90 * time.Second, output: "table"}

	root := &cobra.Command{
		Use:           "marketsignal",
		Short:         "Evidence-backed competitive intelligence from a domain",
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(command *cobra.Command, _ []string) error {
			opts.stdout = command.OutOrStdout()
			opts.stderr = command.ErrOrStderr()
			if opts.output != "json" && opts.output != "table" {
				return fmt.Errorf("--output must be json or table")
			}
			return nil
		},
	}
	root.PersistentFlags().StringVar(&opts.baseURL, "base-url", opts.baseURL, "Market Signal service base URL")
	root.PersistentFlags().DurationVar(&opts.timeout, "timeout", opts.timeout, "request timeout")
	root.PersistentFlags().StringVarP(&opts.output, "output", "o", opts.output, "output format: table or json")
	root.PersistentFlags().BoolVar(&opts.quiet, "quiet", false, "hide progress messages")

	root.AddCommand(newReportCommand(opts, false))
	root.AddCommand(newReportCommand(opts, true))
	root.AddCommand(newSubmitCommand(opts))
	root.AddCommand(newWaitCommand(opts))
	root.AddCommand(newResultCommand(opts))
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the CLI version",
		Run: func(command *cobra.Command, _ []string) {
			fmt.Fprintln(command.OutOrStdout(), version)
		},
	})
	return root
}

func dependencies(opts *options) (*api.Client, *contract.Validator, error) {
	client, err := api.NewClient(opts.baseURL, opts.timeout, opts.apiToken)
	if err != nil {
		return nil, nil, err
	}
	validator, err := contract.NewValidator()
	if err != nil {
		return nil, nil, err
	}
	return client, validator, nil
}
