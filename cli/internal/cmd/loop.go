package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/abdullabostani/market-signal/cli/internal/api"
	"github.com/abdullabostani/market-signal/cli/internal/contract"
	loopmodel "github.com/abdullabostani/market-signal/cli/internal/loop"
	"github.com/abdullabostani/market-signal/cli/internal/render"
	"github.com/spf13/cobra"
)

var (
	loopRequestIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{0,119}$`)
	publicReportIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
)

func newSubmitCommand(opts *options) *cobra.Command {
	var requestID string
	var locale string
	command := &cobra.Command{
		Use:   "submit <domain>",
		Short: "Submit one idempotent report-loop request",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			domain, err := canonicalDomain(args[0])
			if err != nil {
				return err
			}
			requestID = strings.TrimSpace(requestID)
			if !loopRequestIDPattern.MatchString(requestID) {
				return fmt.Errorf("--request-id must begin with a letter or number and contain at most 120 letters, numbers, colons, underscores, or hyphens")
			}
			if locale != "en" && locale != "ar" {
				return fmt.Errorf("--locale must be en or ar")
			}
			client, _, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			stop := startProgress(opts.stderr, opts.quiet, fmt.Sprintf("Submitting %s", domain))
			data, err := client.Post(command.Context(), "/api/reports", map[string]any{
				"primaryDomain": domain,
				"locale":        locale,
				"commandId":     requestID,
			})
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
			if !response.OK || response.RequestID != requestID || !publicReportIDPattern.MatchString(response.Report.PublicID) || response.Report.PrimaryDomain != domain || !validPlanTarget(response.Report.ProductPlan, response.Report.ProductLimit) || response.Report.ProductTargetKind != "pairs" || !validSubmissionLifecycle(response.Replayed, response.Report.Status, response.Report.CurrentPhase, response.Job.Dispatched) || !dispatchValid {
				return &ExitError{Code: 3, Err: fmt.Errorf("report submission contract drift")}
			}
			state := "pending"
			pollAfter := 10
			if terminalReportStatus(response.Report.Status) {
				state = "terminal"
				pollAfter = 0
			}
			result := loopmodel.Submission{
				State:            state,
				RequestID:        requestID,
				PublicReportID:   response.Report.PublicID,
				PrimaryDomain:    response.Report.PrimaryDomain,
				ProductPlan:      response.Report.ProductPlan,
				ComparisonTarget: response.Report.ProductLimit,
				Status:           response.Report.Status,
				PollAfterSeconds: pollAfter,
				Replayed:         response.Replayed,
			}
			if opts.output == "json" {
				encoded, err := json.Marshal(result)
				if err != nil {
					return err
				}
				return render.JSON(opts.stdout, encoded)
			}
			return render.SubmissionTable(opts.stdout, result)
		},
	}
	command.Flags().StringVar(&requestID, "request-id", "", "caller-generated idempotency and correlation id")
	command.Flags().StringVar(&locale, "locale", "en", "report locale: en or ar")
	return command
}

func newWaitCommand(opts *options) *cobra.Command {
	var requestID string
	var poll time.Duration
	var maxWait time.Duration
	command := &cobra.Command{
		Use:   "wait <public-report-id>",
		Short: "Wait for an existing report loop without resubmitting it",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			id, err := loopIdentifiers(args[0], requestID)
			if err != nil {
				return err
			}
			if poll <= 0 || maxWait <= 0 {
				return fmt.Errorf("--poll and --max-wait must be positive durations")
			}
			client, validator, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			deadline := time.Now().Add(maxWait)
			lastPhase := ""
			for {
				data, result, err := fetchLoopResult(command, client, validator, id, requestID)
				if err != nil {
					return err
				}
				if result.State == "terminal" {
					return printLoopResult(opts, data, result)
				}
				if !opts.quiet && result.Phase != lastPhase {
					fmt.Fprintf(opts.stderr, "Report %s: %s (%s, attempt %d)\n", id, result.Status, result.Phase, result.Attempt)
					lastPhase = result.Phase
				}
				if !time.Now().Before(deadline) {
					if err := writeLoopResult(opts, data, result); err != nil {
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
					if err := writeLoopResult(opts, data, result); err != nil {
						return err
					}
					return &ExitError{Code: 6, Err: command.Context().Err()}
				case <-timer.C:
					if !time.Now().Before(deadline) {
						if err := writeLoopResult(opts, data, result); err != nil {
							return err
						}
						return &ExitError{Code: 6, Quiet: true}
					}
				}
			}
		},
	}
	command.Flags().StringVar(&requestID, "request-id", "", "original caller-generated request id")
	command.Flags().DurationVar(&poll, "poll", 15*time.Second, "status polling interval")
	command.Flags().DurationVar(&maxWait, "max-wait", 60*time.Minute, "maximum time to wait before returning a resumable pending result")
	return command
}

func newResultCommand(opts *options) *cobra.Command {
	var requestID string
	command := &cobra.Command{
		Use:   "result <public-report-id>",
		Short: "Read a bounded decision-ready report-loop result",
		Args:  cobra.ExactArgs(1),
		RunE: func(command *cobra.Command, args []string) error {
			id, err := loopIdentifiers(args[0], requestID)
			if err != nil {
				return err
			}
			client, validator, err := dependencies(opts)
			if err != nil {
				return &ExitError{Code: 4, Err: err}
			}
			data, result, err := fetchLoopResult(command, client, validator, id, requestID)
			if err != nil {
				return err
			}
			return printLoopResult(opts, data, result)
		},
	}
	command.Flags().StringVar(&requestID, "request-id", "", "original caller-generated request id")
	return command
}

func fetchLoopResult(command *cobra.Command, client *api.Client, validator *contract.Validator, publicID, requestID string) ([]byte, loopmodel.ResultEnvelope, error) {
	path := "/api/reports/" + publicID + "/result?requestId=" + url.QueryEscape(requestID)
	data, err := client.Get(command.Context(), path)
	if err != nil {
		if command.Context().Err() != nil {
			return nil, loopmodel.ResultEnvelope{}, &ExitError{Code: 6, Err: command.Context().Err()}
		}
		return nil, loopmodel.ResultEnvelope{}, loopAPIError(err)
	}
	if err := validator.Validate(contract.ReportResult, data); err != nil {
		return nil, loopmodel.ResultEnvelope{}, &ExitError{Code: 3, Err: err}
	}
	result, err := loopmodel.DecodeResult(data)
	if err != nil {
		return nil, loopmodel.ResultEnvelope{}, &ExitError{Code: 3, Err: fmt.Errorf("decode loop result: %w", err)}
	}
	if err := result.Validate(publicID, requestID); err != nil {
		return nil, loopmodel.ResultEnvelope{}, &ExitError{Code: 3, Err: fmt.Errorf("validate loop result semantics: %w", err)}
	}
	return data, result, nil
}

func printLoopResult(opts *options, data []byte, result loopmodel.ResultEnvelope) error {
	if err := writeLoopResult(opts, data, result); err != nil {
		return err
	}
	if result.State == "pending" {
		return &ExitError{Code: 6, Quiet: true}
	}
	if result.Output == nil {
		return &ExitError{Code: 3, Err: fmt.Errorf("terminal loop result has no output")}
	}
	switch result.Output.Status {
	case "complete":
		return nil
	case "limited":
		return &ExitError{Code: 2, Quiet: true}
	case "failed":
		return &ExitError{Code: 5, Quiet: true}
	case "outcome_unknown":
		if opts.internal {
			return &ExitError{Code: 10, Quiet: true}
		}
		return &ExitError{Code: 6, Quiet: true}
	default:
		return &ExitError{Code: 3, Err: fmt.Errorf("unsupported terminal loop status %q", result.Output.Status)}
	}
}

func writeLoopResult(opts *options, data []byte, result loopmodel.ResultEnvelope) error {
	if opts.output == "json" {
		return render.JSON(opts.stdout, data)
	}
	return render.LoopResultTable(opts.stdout, result)
}

func loopIdentifiers(rawPublicID, rawRequestID string) (string, error) {
	publicID := strings.TrimSpace(strings.ToLower(rawPublicID))
	requestID := strings.TrimSpace(rawRequestID)
	if !publicReportIDPattern.MatchString(publicID) {
		return "", fmt.Errorf("public report id must be 32 lowercase hexadecimal characters")
	}
	if !loopRequestIDPattern.MatchString(requestID) {
		return "", fmt.Errorf("--request-id must be the original caller-generated request id")
	}
	return publicID, nil
}

func validPlanTarget(plan string, target int) bool {
	return map[string]int{"starter": 20, "solo": 50, "growth": 500, "agency": 1000}[plan] == target
}

func terminalReportStatus(status string) bool {
	return status == "complete" || status == "limited" || status == "failed" || status == "interrupted"
}

func validSubmissionLifecycle(replayed bool, status, phase string, dispatched bool) bool {
	if !replayed {
		return status == "queued" && phase == "queued" && dispatched
	}
	switch status {
	case "queued":
		return phase == "queued"
	case "running":
		return phase != "queued" && phase != "complete" && phase != "failed" && phase != "interrupted" && !dispatched
	case "complete", "limited":
		return phase == "complete" && !dispatched
	case "failed":
		return phase == "failed" && !dispatched
	case "interrupted":
		return phase == "interrupted" && !dispatched
	default:
		return false
	}
}

func loopAPIError(err error) error {
	var apiErr *api.APIError
	if errors.As(err, &apiErr) {
		if apiErr.Status == 402 || apiErr.Status == 429 {
			return &ExitError{Code: 7, Err: err}
		}
		if apiErr.Status == 409 && (apiErr.Code == "facts-inconsistent" || apiErr.Code == "facts-unavailable") {
			return &ExitError{Code: 8, Err: err}
		}
	}
	return &ExitError{Code: 4, Err: err}
}

func reportAPIError(opts *options, err error) error {
	var apiErr *api.APIError
	if opts.internal && errors.As(err, &apiErr) && apiErr.Status == 409 && apiErr.Code == "idempotency-conflict" {
		return &ExitError{Code: 9, Err: err}
	}
	return loopAPIError(err)
}
