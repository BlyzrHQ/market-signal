package cmd

import (
	"fmt"
	"io"

	"github.com/abdullabostani/market-signal/cli/internal/contract"
	"github.com/abdullabostani/market-signal/cli/internal/render"
	"github.com/spf13/cobra"
)

func newAdsCommand(opts *options) *cobra.Command {
	var competitors []string
	var region string
	command := &cobra.Command{
		Use:   "ads <domain>",
		Short: "Scan public ad-library evidence for a company set",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			domains := append([]string{args[0]}, competitors...)
			companies := make([]map[string]string, 0, len(domains))
			seen := map[string]bool{}
			for _, input := range domains {
				domain, err := canonicalDomain(input)
				if err != nil {
					return err
				}
				if !seen[domain] {
					companies = append(companies, map[string]string{"domain": domain, "brand": domain})
					seen[domain] = true
				}
			}
			client, validator, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			stop := startProgress(opts.stderr, opts.quiet, fmt.Sprintf("Checking public ad evidence for %d company(s)", len(companies)))
			data, err := client.Post(command.Context(), "/api/ads", map[string]any{"companies": companies, "region": region})
			stop()
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			if err := validator.Validate(contract.Ads, data); err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			limited, err := render.AdsTable(io.Discard, data)
			if err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if opts.output == "json" {
				if err := render.JSON(opts.stdout, data); err != nil {
					return err
				}
				if limited {
					return &ExitError{Code: 2, Quiet: true}
				}
				return nil
			}
			limited, err = render.AdsTable(opts.stdout, data)
			if err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if limited {
				return &ExitError{Code: 2, Quiet: true}
			}
			return nil
		},
	}
	command.Flags().StringSliceVar(&competitors, "competitor", nil, "verified competitor domain (repeatable)")
	command.Flags().StringVar(&region, "region", "Global market", "market region; a specific country improves Meta coverage")
	return command
}
