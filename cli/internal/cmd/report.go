package cmd

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/abdullabostani/market-signal/cli/internal/contract"
	loopmodel "github.com/abdullabostani/market-signal/cli/internal/loop"
	"github.com/abdullabostani/market-signal/cli/internal/render"
	"github.com/spf13/cobra"
)

func generatedRequestID(domain string) (string, error) {
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", fmt.Errorf("generate report request id: %w", err)
	}
	label := strings.NewReplacer(".", "-", "_", "-", ":", "-").Replace(domain)
	return fmt.Sprintf("cli:%s:%s:%s", label, time.Now().UTC().Format("20060102T150405Z"), hex.EncodeToString(random)), nil
}

func newReportCommand(opts *options) *cobra.Command {
	var locale string
	var poll time.Duration
	var maxWait time.Duration
	var requestID string
	comparisonTarget := 20
	command := &cobra.Command{
		Use:   "report <domain>",
		Short: "Build and return a private competitive-intelligence report",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			domain, err := canonicalDomain(args[0])
			if err != nil {
				return err
			}
			if locale != "en" && locale != "ar" {
				return fmt.Errorf("--locale must be en or ar")
			}
			if poll <= 0 || maxWait <= 0 {
				return fmt.Errorf("--poll and --max-wait must be positive durations")
			}
			if opts.internal && !validPlanTarget(map[int]string{20: "starter", 50: "solo", 500: "growth", 1000: "agency"}[comparisonTarget], comparisonTarget) {
				return fmt.Errorf("--comparisons must be 20, 50, 500, or 1000")
			}
			requestID = strings.TrimSpace(requestID)
			if opts.internal && requestID == "" {
				return fmt.Errorf("--request-id is required for internal reports so retries cannot create duplicate paid work")
			}
			if requestID == "" {
				requestID, err = generatedRequestID(domain)
				if err != nil {
					return err
				}
			}
			if !loopRequestIDPattern.MatchString(requestID) {
				return fmt.Errorf("--request-id must begin with a letter or number and contain at most 120 letters, numbers, colons, underscores, or hyphens")
			}

			client, validator, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			stop := startProgress(opts.stderr, opts.quiet, fmt.Sprintf("Submitting %s", domain))
			payload := map[string]any{
				"primaryDomain": domain,
				"locale":        locale,
				"commandId":     requestID,
			}
			if opts.internal {
				payload["comparisonTarget"] = comparisonTarget
			}
			data, err := client.Post(command.Context(), "/api/reports", payload)
			stop()
			if err != nil {
				return loopAPIError(err)
			}
			var response loopmodel.APIReportSubmission
			if err := json.Unmarshal(data, &response); err != nil {
				return &ExitError{Code: 3, Err: fmt.Errorf("decode report submission: %w", err)}
			}
			dispatchValid := (!response.Job.Dispatched && response.Job.RunID == "") || (response.Job.Dispatched && loopRequestIDPattern.MatchString(response.Job.RunID))
			if !response.Replayed {
				dispatchValid = response.Job.Dispatched && loopRequestIDPattern.MatchString(response.Job.RunID)
			}
			if !response.OK || response.RequestID != requestID || !publicReportIDPattern.MatchString(response.Report.PublicID) || response.Report.PrimaryDomain != domain || !validPlanTarget(response.Report.ProductPlan, response.Report.ProductLimit) || (opts.internal && response.Report.ProductLimit != comparisonTarget) || response.Report.ProductTargetKind != "pairs" || !validSubmissionLifecycle(response.Replayed, response.Report.Status, response.Report.CurrentPhase, response.Job.Dispatched) || !dispatchValid {
				return &ExitError{Code: 3, Err: fmt.Errorf("report submission contract drift")}
			}

			deadline := time.Now().Add(maxWait)
			lastPhase := ""
			for {
				resultData, result, err := fetchLoopResult(command, client, validator, response.Report.PublicID, requestID)
				if err != nil {
					return err
				}
				if result.State == "terminal" {
					return printLoopResult(opts, resultData, result)
				}
				if !opts.quiet && result.Phase != lastPhase {
					fmt.Fprintf(opts.stderr, "Report %s: %s (%s, attempt %d)\n", response.Report.PublicID, result.Status, result.Phase, result.Attempt)
					lastPhase = result.Phase
				}
				if !time.Now().Before(deadline) {
					if err := writeLoopResult(opts, resultData, result); err != nil {
						return err
					}
					return &ExitError{Code: 6, Quiet: true}
				}
				wait := poll
				if serverPoll := time.Duration(result.PollAfter) * time.Second; serverPoll > wait {
					wait = serverPoll
				}
				if remaining := time.Until(deadline); wait > remaining {
					wait = remaining
				}
				timer := time.NewTimer(wait)
				select {
				case <-command.Context().Done():
					timer.Stop()
					if err := writeLoopResult(opts, resultData, result); err != nil {
						return err
					}
					return &ExitError{Code: 6, Err: command.Context().Err()}
				case <-timer.C:
				}
			}
		},
	}
	command.Flags().StringVar(&locale, "locale", "en", "report locale: en or ar")
	command.Flags().DurationVar(&poll, "poll", 15*time.Second, "status polling interval")
	command.Flags().DurationVar(&maxWait, "max-wait", 60*time.Minute, "maximum time to wait before returning a resumable pending result")
	requestIDHelp := "optional idempotency and correlation id"
	if opts.internal {
		requestIDHelp = "required caller-owned idempotency and correlation id"
	}
	command.Flags().StringVar(&requestID, "request-id", "", requestIDHelp)
	if opts.internal {
		command.Flags().IntVar(&comparisonTarget, "comparisons", 20, "priced comparison-pair target: 20, 50, 500, or 1000")
	}
	return command
}

func newCrawlCommand(opts *options) *cobra.Command {
	return &cobra.Command{
		Use:   "crawl <domain>",
		Short: "Run the direct crawl diagnostic against a controlled service",
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
			gaps, err := render.ReportTable(io.Discard, data, true)
			if err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if opts.output == "json" {
				if err := render.JSON(opts.stdout, data); err != nil {
					return err
				}
			} else if gaps, err = render.ReportTable(opts.stdout, data, true); err != nil {
				return &ExitError{Code: 3, Err: err}
			}
			if gaps {
				return &ExitError{Code: 2, Quiet: true}
			}
			return nil
		},
	}
}
