package loop

import (
	"encoding/json"
	"fmt"
	"math"
)

type Submission struct {
	State            string `json:"state"`
	RequestID        string `json:"requestId"`
	PublicReportID   string `json:"publicReportId"`
	PrimaryDomain    string `json:"primaryDomain"`
	ProductPlan      string `json:"productPlan"`
	ComparisonTarget int    `json:"comparisonTarget"`
	Status           string `json:"status"`
	PollAfterSeconds int    `json:"pollAfterSeconds"`
	Replayed         bool   `json:"replayed"`
}

type APIReportSubmission struct {
	OK        bool   `json:"ok"`
	RequestID string `json:"requestId"`
	Replayed  bool   `json:"replayed"`
	Report    struct {
		PublicID          string `json:"publicId"`
		PrimaryDomain     string `json:"primaryDomain"`
		ProductPlan       string `json:"productPlan"`
		ProductLimit      int    `json:"productLimit"`
		ProductTargetKind string `json:"productTargetKind"`
		Status            string `json:"status"`
		CurrentPhase      string `json:"currentPhase"`
	} `json:"report"`
	Job struct {
		Dispatched bool   `json:"dispatched"`
		RunID      string `json:"runId"`
	} `json:"job"`
}

type ResultEnvelope struct {
	State          string       `json:"state"`
	RequestID      string       `json:"requestId,omitempty"`
	PublicReportID string       `json:"publicReportId,omitempty"`
	PrimaryDomain  string       `json:"primaryDomain,omitempty"`
	Status         string       `json:"status,omitempty"`
	Phase          string       `json:"phase,omitempty"`
	Attempt        int          `json:"attempt,omitempty"`
	HeartbeatAt    string       `json:"heartbeatAt,omitempty"`
	PollAfter      int          `json:"pollAfterSeconds,omitempty"`
	Output         *Output      `json:"output,omitempty"`
	Decision       *Decision    `json:"decision,omitempty"`
	Comparisons    *Comparisons `json:"comparisons,omitempty"`
}

type Output struct {
	ContractVersion string `json:"contractVersion"`
	FunctionID      string `json:"functionId"`
	FunctionVersion string `json:"functionVersion"`
	RequestID       string `json:"requestId"`
	PrimaryDomain   string `json:"primaryDomain"`
	ProductPlan     string `json:"productPlan"`
	RunID           string `json:"runId"`
	Status          string `json:"status"`
	Report          *struct {
		PublicID        string   `json:"publicId"`
		OwnerPath       string   `json:"ownerPath"`
		Status          string   `json:"status"`
		CompletedPhases []string `json:"completedPhases"`
		LimitedPhases   []string `json:"limitedPhases"`
	} `json:"report"`
	Artifacts []Artifact `json:"artifacts"`
	Metrics   struct {
		ComparisonTarget     int    `json:"comparisonTarget"`
		PublishedComparisons int    `json:"publishedComparisons"`
		PricedComparisons    int    `json:"pricedComparisons"`
		CompetitorCount      int    `json:"competitorCount"`
		RepairRounds         int    `json:"repairRounds"`
		UsageStatus          string `json:"usageStatus"`
		CostMicrousd         *int64 `json:"costMicrousd"`
		DurationMs           int64  `json:"durationMs"`
	} `json:"metrics"`
	Evaluation struct {
		Status           string  `json:"status"`
		EvaluationID     *string `json:"evaluationId"`
		EvaluatorVersion *string `json:"evaluatorVersion"`
		ResultHash       *string `json:"resultHash"`
	} `json:"evaluation"`
	Failure *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"failure"`
}

type Artifact struct {
	Kind        string `json:"kind"`
	Reference   string `json:"reference"`
	ContentHash string `json:"contentHash"`
	RecordCount *int   `json:"recordCount"`
}

type Decision struct {
	Headline string `json:"headline"`
	Coverage struct {
		Target    int     `json:"target"`
		Delivered int     `json:"delivered"`
		Percent   float64 `json:"percent"`
	} `json:"coverage"`
	CompetitorDomains  []string `json:"competitorDomains"`
	Limitations        []string `json:"limitations"`
	RecommendedActions []string `json:"recommendedActions"`
}

type Comparisons struct {
	Inline       []map[string]any `json:"inline"`
	TotalCount   int              `json:"totalCount"`
	ManifestHash string           `json:"manifestHash"`
	NextCursor   *string          `json:"nextCursor"`
	PageURL      string           `json:"pageUrl"`
}

func DecodeResult(data []byte) (ResultEnvelope, error) {
	var result ResultEnvelope
	err := json.Unmarshal(data, &result)
	return result, err
}

func (result ResultEnvelope) Validate(expectedPublicID, expectedRequestID string) error {
	if result.State == "pending" {
		if result.RequestID != expectedRequestID || result.PublicReportID != expectedPublicID {
			return fmt.Errorf("pending result identity does not match the requested report")
		}
		if result.Status != "queued" && result.Status != "running" {
			return fmt.Errorf("pending result has invalid status %q", result.Status)
		}
		if result.Attempt < 1 || result.PollAfter < 1 || result.Output != nil || result.Decision != nil || result.Comparisons != nil {
			return fmt.Errorf("pending result contains invalid lifecycle fields")
		}
		return nil
	}
	if result.State != "terminal" || result.Output == nil || result.Decision == nil || result.Comparisons == nil {
		return fmt.Errorf("terminal result is incomplete")
	}
	out := result.Output
	if out.ContractVersion != "1" || out.FunctionID != "market-signal.report" || out.FunctionVersion != "1" {
		return fmt.Errorf("terminal result function identity is invalid")
	}
	if out.RequestID != expectedRequestID {
		return fmt.Errorf("terminal result request id does not match the caller")
	}
	targets := map[string]int{"starter": 20, "solo": 50, "growth": 500, "agency": 1000}
	target, ok := targets[out.ProductPlan]
	if !ok || out.Metrics.ComparisonTarget != target {
		return fmt.Errorf("terminal result plan and comparison target disagree")
	}
	m := out.Metrics
	if m.PublishedComparisons != m.PricedComparisons || m.PublishedComparisons > target || m.CompetitorCount > m.PublishedComparisons || m.RepairRounds > 3 {
		return fmt.Errorf("terminal result metrics violate the comparison contract")
	}
	if (m.UsageStatus == "known") != (m.CostMicrousd != nil) {
		return fmt.Errorf("terminal result cost does not match its usage status")
	}
	if m.UsageStatus != "known" && m.UsageStatus != "unknown" && m.UsageStatus != "not_called" {
		return fmt.Errorf("terminal result usage status is invalid")
	}
	if out.Status == "complete" || out.Status == "limited" {
		if out.Report == nil || out.Report.PublicID != expectedPublicID || out.Report.OwnerPath != "/reports/"+expectedPublicID || out.Report.Status != out.Status {
			return fmt.Errorf("successful result is not bound to the requested private report")
		}
		if out.Failure != nil {
			return fmt.Errorf("successful result cannot contain failure detail")
		}
		if out.Status == "complete" && m.PublishedComparisons != target {
			return fmt.Errorf("complete result did not fill its comparison target")
		}
		if err := validateArtifacts(out.Artifacts, m.PublishedComparisons, result.Comparisons.ManifestHash); err != nil {
			return err
		}
	} else if out.Status == "failed" || out.Status == "outcome_unknown" {
		if out.Report != nil || out.Failure == nil {
			return fmt.Errorf("failed or unknown result has inconsistent failure fields")
		}
	} else {
		return fmt.Errorf("terminal result status is invalid")
	}
	if result.Decision.Coverage.Target != target || result.Decision.Coverage.Delivered != m.PublishedComparisons || result.Comparisons.TotalCount != m.PublishedComparisons {
		return fmt.Errorf("decision coverage does not match terminal metrics")
	}
	expectedPercent := 0.0
	if target > 0 {
		expectedPercent = math.Round(float64(m.PublishedComparisons)/float64(target)*10000) / 100
	}
	if math.Abs(result.Decision.Coverage.Percent-expectedPercent) > 0.001 || len(result.Decision.CompetitorDomains) != m.CompetitorCount {
		return fmt.Errorf("decision summary does not match terminal metrics")
	}
	if len(result.Comparisons.Inline) > 50 || len(result.Comparisons.Inline) > result.Comparisons.TotalCount {
		return fmt.Errorf("inline comparisons exceed their bounded total")
	}
	evaluationComplete := out.Evaluation.Status == "complete" || out.Evaluation.Status == "needs_human_review"
	evaluationIdentity := out.Evaluation.EvaluationID != nil && out.Evaluation.EvaluatorVersion != nil && out.Evaluation.ResultHash != nil
	if evaluationComplete != evaluationIdentity {
		return fmt.Errorf("evaluation status and identity disagree")
	}
	if !evaluationComplete && (out.Evaluation.EvaluationID != nil || out.Evaluation.EvaluatorVersion != nil || out.Evaluation.ResultHash != nil) {
		return fmt.Errorf("unfinished evaluation claims a completed identity")
	}
	return nil
}

func validateArtifacts(artifacts []Artifact, published int, manifestHash string) error {
	reports := 0
	comparisons := 0
	for _, artifact := range artifacts {
		switch artifact.Kind {
		case "report":
			reports++
			if artifact.RecordCount == nil || *artifact.RecordCount != 1 {
				return fmt.Errorf("report artifact count is invalid")
			}
		case "comparisons":
			comparisons++
			if artifact.RecordCount == nil || *artifact.RecordCount != published || artifact.ContentHash != manifestHash {
				return fmt.Errorf("comparison artifact is not bound to the published result")
			}
		}
	}
	if reports != 1 || comparisons != 1 {
		return fmt.Errorf("successful result requires one report and one comparison artifact")
	}
	return nil
}
