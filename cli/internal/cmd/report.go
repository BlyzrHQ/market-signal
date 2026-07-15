package cmd

import (
	"fmt"
	"io"

	"github.com/abdullabostani/market-signal/cli/internal/contract"
	"github.com/abdullabostani/market-signal/cli/internal/render"
	"github.com/spf13/cobra"
)

func newReportCommand(opts *options, crawlOnly bool) *cobra.Command {
	name := "report"
	short := "Build and summarize a live competitive-intelligence report"
	if crawlOnly {
		name = "crawl"
		short = "Run the full report pipeline and summarize crawl coverage"
	}
	return &cobra.Command{
		Use:   name + " <domain>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			domain, err := canonicalDomain(args[0])
			if err != nil {
				return err
			}
			client, validator, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			stop := startProgress(opts.stderr, opts.quiet, fmt.Sprintf("Analyzing %s", domain))
			data, err := client.Post(command.Context(), "/api/crawl", map[string]any{"primary": domain, "domains": []string{domain}})
			stop()
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			if err := validator.Validate(contract.Report, data); err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			gaps, err := render.ReportTable(io.Discard, data, crawlOnly)
			if err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if opts.output == "json" {
				if err := render.JSON(opts.stdout, data); err != nil {
					return err
				}
				if gaps {
					return &ExitError{Code: 2, Quiet: true}
				}
				return nil
			}
			gaps, err = render.ReportTable(opts.stdout, data, crawlOnly)
			if err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if gaps {
				return &ExitError{Code: 2, Quiet: true}
			}
			return nil
		},
	}
}
