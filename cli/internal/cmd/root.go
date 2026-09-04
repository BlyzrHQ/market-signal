package cmd

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/abdullabostani/market-signal/cli/internal/api"
	"github.com/abdullabostani/market-signal/cli/internal/contract"
	"github.com/abdullabostani/market-signal/cli/internal/oauth"
	"github.com/spf13/cobra"
)

type options struct {
	baseURL                 string
	apiToken                string
	apiKey                  string
	timeout                 time.Duration
	output                  string
	quiet                   bool
	stdout                  io.Writer
	stderr                  io.Writer
	auth                    *oauth.Manager
	internal                bool
	allowInternalTestOrigin bool
}

func NewRoot(version string) *cobra.Command {
	defaultBaseURL := strings.TrimSpace(os.Getenv("MARKET_SIGNAL_BASE_URL"))
	if defaultBaseURL == "" {
		defaultBaseURL = oauth.ProductionOrigin
	}
	opts := &options{
		baseURL:  defaultBaseURL,
		apiToken: strings.TrimSpace(os.Getenv("MARKET_SIGNAL_API_TOKEN")),
		apiKey:   strings.TrimSpace(os.Getenv("MARKET_SIGNAL_API_KEY")),
		timeout:  90 * time.Second,
		output:   "table",
		auth:     oauth.NewManager(oauth.NewKeyringStore(), 90*time.Second),
	}

	root := &cobra.Command{
		Use:           "marketsignal",
		Short:         "Evidence-backed competitive intelligence from a domain",
		SilenceUsage:  true,
		SilenceErrors: true,
		CompletionOptions: cobra.CompletionOptions{
			DisableDefaultCmd: true,
		},
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
	_ = root.PersistentFlags().MarkHidden("base-url")
	_ = root.PersistentFlags().MarkHidden("timeout")

	reportCommand := newReportCommand(opts)
	crawlCommand := newCrawlCommand(opts)
	submitCommand := newSubmitCommand(opts)
	waitCommand := newWaitCommand(opts)
	resultCommand := newResultCommand(opts)
	for _, advanced := range []*cobra.Command{crawlCommand, submitCommand, waitCommand, resultCommand} {
		advanced.Hidden = true
	}
	root.AddCommand(reportCommand)
	root.AddCommand(crawlCommand)
	root.AddCommand(submitCommand)
	root.AddCommand(waitCommand)
	root.AddCommand(resultCommand)
	root.AddCommand(newLoginCommand(opts))
	root.AddCommand(newLogoutCommand(opts))
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the CLI version",
		Run: func(command *cobra.Command, _ []string) {
			fmt.Fprintln(command.OutOrStdout(), version)
		},
	})
	return root
}

const internalCredentialService = "Market Signal Internal CLI"

func NewInternalRoot(version string) *cobra.Command {
	store := oauth.NewKeyringStoreWithService(internalCredentialService)
	manager := oauth.NewManager(store, 90*time.Second)
	return newInternalRoot(version, manager, false)
}

func newInternalRoot(version string, manager *oauth.Manager, allowTestOrigin bool) *cobra.Command {
	opts := &options{
		baseURL:                 oauth.ProductionOrigin,
		timeout:                 90 * time.Second,
		output:                  "json",
		quiet:                   true,
		auth:                    manager,
		internal:                true,
		allowInternalTestOrigin: allowTestOrigin,
	}
	root := &cobra.Command{
		Use:               "marketsignal-internal",
		Short:             "Company-internal Market Signal report loop",
		SilenceUsage:      true,
		SilenceErrors:     true,
		CompletionOptions: cobra.CompletionOptions{DisableDefaultCmd: true},
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
	root.PersistentFlags().StringVarP(&opts.output, "output", "o", opts.output, "output format: json or table")
	root.PersistentFlags().BoolVar(&opts.quiet, "quiet", opts.quiet, "hide progress messages")
	_ = root.PersistentFlags().MarkHidden("base-url")
	_ = root.PersistentFlags().MarkHidden("timeout")

	root.AddCommand(newReportCommand(opts))
	root.AddCommand(newWaitCommand(opts))
	root.AddCommand(newResultCommand(opts))
	configure := newInternalConfigureCommand(opts)
	configure.Hidden = true
	root.AddCommand(configure)
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the internal CLI version",
		Run:   func(command *cobra.Command, _ []string) { fmt.Fprintln(command.OutOrStdout(), version) },
	})
	return root
}

func dependencies(opts *options) (*api.Client, *contract.Validator, error) {
	var client *api.Client
	var err error
	origin := strings.TrimRight(strings.TrimSpace(opts.baseURL), "/")
	if opts.internal {
		if origin != oauth.ProductionOrigin && !opts.allowInternalTestOrigin {
			return nil, nil, fmt.Errorf("the internal credential can be sent only to %s", oauth.ProductionOrigin)
		}
		client, err = api.NewClientWithTokenSource(opts.baseURL, opts.timeout, func(ctx context.Context) (string, error) {
			token, tokenErr := opts.auth.AccessToken(ctx, opts.baseURL)
			if tokenErr != nil {
				return "", fmt.Errorf("internal credential is not provisioned on this machine")
			}
			return token, nil
		})
		if err != nil {
			return nil, nil, err
		}
		validator, validatorErr := contract.NewValidator()
		if validatorErr != nil {
			return nil, nil, validatorErr
		}
		return client, validator, nil
	}
	if opts.apiKey != "" && opts.apiToken != "" {
		return nil, nil, fmt.Errorf("set only one of MARKET_SIGNAL_API_KEY or MARKET_SIGNAL_API_TOKEN")
	}
	if opts.apiKey != "" {
		if origin != oauth.ProductionOrigin {
			return nil, nil, fmt.Errorf("MARKET_SIGNAL_API_KEY can be sent only to %s", oauth.ProductionOrigin)
		}
		if !oauth.ValidHostedAPIKey(opts.apiKey) {
			return nil, nil, fmt.Errorf("MARKET_SIGNAL_API_KEY is not a valid Market Signal workspace key")
		}
		client, err = api.NewClient(opts.baseURL, opts.timeout, opts.apiKey)
	} else if opts.apiToken != "" {
		if origin == oauth.ProductionOrigin {
			return nil, nil, fmt.Errorf("MARKET_SIGNAL_API_TOKEN is for controlled self-hosted deployments; use MARKET_SIGNAL_API_KEY or marketsignal login for the hosted service")
		}
		client, err = api.NewClient(opts.baseURL, opts.timeout, opts.apiToken)
	} else if origin == oauth.ProductionOrigin {
		client, err = api.NewClientWithTokenSource(opts.baseURL, opts.timeout, func(ctx context.Context) (string, error) {
			return opts.auth.AccessToken(ctx, opts.baseURL)
		})
	} else {
		client, err = api.NewClient(opts.baseURL, opts.timeout)
	}
	if err != nil {
		return nil, nil, err
	}
	validator, err := contract.NewValidator()
	if err != nil {
		return nil, nil, err
	}
	return client, validator, nil
}
