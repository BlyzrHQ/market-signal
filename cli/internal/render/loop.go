package render

import (
	"fmt"
	"io"
	"strings"

	"github.com/abdullabostani/market-signal/cli/internal/loop"
)

func SubmissionTable(writer io.Writer, value loop.Submission) error {
	nextCommand := "wait"
	if value.State == "terminal" {
		nextCommand = "result"
	}
	_, err := fmt.Fprintf(writer, "Market Signal report submitted\n\nDomain       %s\nRequest      %s\nReport       %s\nPlan         %s (%d comparisons)\nState        %s%s\nNext         marketsignal %s %s --request-id %s\n",
		value.PrimaryDomain,
		value.RequestID,
		value.PublicReportID,
		value.ProductPlan,
		value.ComparisonTarget,
		value.Status,
		map[bool]string{true: " (idempotent replay)", false: ""}[value.Replayed],
		nextCommand,
		value.PublicReportID,
		value.RequestID,
	)
	return err
}

func LoopResultTable(writer io.Writer, result loop.ResultEnvelope) error {
	if result.State == "pending" {
		_, err := fmt.Fprintf(writer, "Market Signal report pending\n\nDomain       %s\nRequest      %s\nReport       %s\nState        %s\nPhase        %s\nAttempt      %d\nHeartbeat    %s\nPoll after   %ds\n",
			result.PrimaryDomain, result.RequestID, result.PublicReportID, result.Status, result.Phase, result.Attempt, result.HeartbeatAt, result.PollAfter)
		return err
	}
	if result.Output == nil || result.Decision == nil || result.Comparisons == nil {
		return fmt.Errorf("terminal result is missing decision data")
	}
	output := result.Output
	decision := result.Decision
	cost := "unknown"
	if output.Metrics.UsageStatus == "not_called" {
		cost = "not called"
	} else if output.Metrics.UsageStatus == "known" && output.Metrics.CostMicrousd != nil {
		cost = fmt.Sprintf("$%.6f", float64(*output.Metrics.CostMicrousd)/1_000_000)
	}
	limitations := "none"
	if len(decision.Limitations) > 0 {
		limitations = strings.Join(decision.Limitations, "; ")
	}
	if _, err := fmt.Fprintf(writer, "Market Signal loop result\n\n%s\n\nDomain       %s\nRequest      %s\nRun          %s\nStatus       %s\nPlan         %s\nCoverage     %d/%d priced comparisons (%.1f%%)\nCompetitors  %d (%s)\nRepairs      %d/3\nEvaluation   %s\nProvider cost %s\nLimitations  %s\n",
		decision.Headline,
		output.PrimaryDomain,
		output.RequestID,
		output.RunID,
		strings.ToUpper(output.Status),
		output.ProductPlan,
		output.Metrics.PricedComparisons,
		output.Metrics.ComparisonTarget,
		decision.Coverage.Percent,
		output.Metrics.CompetitorCount,
		strings.Join(decision.CompetitorDomains, ", "),
		output.Metrics.RepairRounds,
		output.Evaluation.Status,
		cost,
		limitations,
	); err != nil {
		return err
	}

	if len(result.Comparisons.Inline) > 0 {
		if _, err := fmt.Fprintln(writer, "\nSample comparisons"); err != nil {
			return err
		}
		limit := len(result.Comparisons.Inline)
		if limit > 5 {
			limit = 5
		}
		for _, row := range result.Comparisons.Inline[:limit] {
			primary := object(row["primary"])
			rival := object(row["rival"])
			match := object(row["match"])
			assessment := object(match["assessment"])
			if _, err := fmt.Fprintf(writer, "- %s → %s (%s, %s)\n", text(primary["name"]), text(rival["name"]), text(rival["domain"]), text(assessment["verdict"])); err != nil {
				return err
			}
		}
	}
	if len(decision.RecommendedActions) > 0 {
		if _, err := fmt.Fprintln(writer, "\nRecommended actions"); err != nil {
			return err
		}
		for _, action := range decision.RecommendedActions {
			if _, err := fmt.Fprintf(writer, "- %s\n", action); err != nil {
				return err
			}
		}
	}
	return nil
}

func object(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

func text(value any) string {
	result, _ := value.(string)
	if strings.TrimSpace(result) == "" {
		return "unknown"
	}
	return strings.TrimSpace(result)
}
