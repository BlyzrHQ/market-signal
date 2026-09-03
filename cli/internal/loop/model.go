package loop

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	domainPattern   = regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)
	matchIDPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	publicIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
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
	Competitors    *Competitors `json:"competitors,omitempty"`
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
	StartedAt  string `json:"startedAt"`
	FinishedAt string `json:"finishedAt"`
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

type Competitors struct {
	Authoritative bool         `json:"authoritative"`
	Items         []Competitor `json:"items"`
	TotalCount    int          `json:"totalCount"`
}

type Competitor struct {
	Domain                 string   `json:"domain"`
	Name                   string   `json:"name"`
	ComparisonCount        int      `json:"comparisonCount"`
	ComparisonSharePercent float64  `json:"comparisonSharePercent"`
	Relationship           string   `json:"relationship"`
	Confidence             string   `json:"confidence"`
	Reason                 string   `json:"reason"`
	VerificationScore      *float64 `json:"verificationScore"`
	WebsiteURL             *string  `json:"websiteUrl"`
}

type Comparisons struct {
	Authoritative    bool         `json:"authoritative"`
	Items            []Comparison `json:"items"`
	ReturnedCount    int          `json:"returnedCount"`
	TotalCount       int          `json:"totalCount"`
	DirectPriceCount int          `json:"directPriceCount"`
	ManifestHash     string       `json:"manifestHash"`
	NextCursor       *string      `json:"nextCursor"`
	PageURL          string       `json:"pageUrl"`
}

type Comparison struct {
	ID              string          `json:"id"`
	PrimaryProduct  Product         `json:"primaryProduct"`
	RivalProduct    Product         `json:"rivalProduct"`
	Match           Match           `json:"match"`
	PriceComparison PriceComparison `json:"priceComparison"`
	Recommendation  Recommendation  `json:"recommendation"`
}

type Product struct {
	ID         string    `json:"id"`
	Domain     string    `json:"domain"`
	Title      string    `json:"title"`
	SourceURL  string    `json:"sourceUrl"`
	ImageURL   *string   `json:"imageUrl"`
	ObservedAt string    `json:"observedAt"`
	Price      Price     `json:"price"`
	Quantity   *Quantity `json:"quantity"`
}

type Price struct {
	Display  string  `json:"display"`
	Amount   float64 `json:"amount"`
	Currency string  `json:"currency"`
}

type Quantity struct {
	Kind   string  `json:"kind"`
	Amount float64 `json:"amount"`
	Unit   string  `json:"unit"`
}

type Match struct {
	Verdict        string   `json:"verdict"`
	Confidence     float64  `json:"confidence"`
	Score          float64  `json:"score"`
	Method         string   `json:"method"`
	ClaimType      string   `json:"claimType"`
	Reasons        []string `json:"reasons"`
	Contradictions []string `json:"contradictions"`
	SharedTerms    []string `json:"sharedTerms"`
	Category       *string  `json:"category"`
	Variant        *string  `json:"variant"`
	Size           *string  `json:"size"`
	Model          *string  `json:"model"`
	PromptVersion  *string  `json:"promptVersion"`
}

type PriceComparison struct {
	Kind              string   `json:"kind"`
	Position          string   `json:"position"`
	Currency          *string  `json:"currency"`
	PrimaryAmount     *float64 `json:"primaryAmount"`
	RivalAmount       *float64 `json:"rivalAmount"`
	GapAmount         *float64 `json:"gapAmount"`
	GapPercent        *float64 `json:"gapPercent"`
	UnitBasis         *float64 `json:"unitBasis"`
	Unit              *string  `json:"unit"`
	PrimaryUnitAmount *float64 `json:"primaryUnitAmount"`
	RivalUnitAmount   *float64 `json:"rivalUnitAmount"`
	UnavailableReason *string  `json:"unavailableReason"`
	Summary           string   `json:"summary"`
	Detail            string   `json:"detail"`
	Note              string   `json:"note"`
}

type Recommendation struct {
	Action        *string  `json:"action"`
	Rationale     *string  `json:"rationale"`
	Source        string   `json:"source"`
	LeverType     *string  `json:"leverType"`
	Model         *string  `json:"model"`
	PromptVersion *string  `json:"promptVersion"`
	EvidenceKeys  []string `json:"evidenceKeys"`
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
		if result.Attempt < 1 || result.PollAfter < 1 || result.Output != nil || result.Decision != nil || result.Competitors != nil || result.Comparisons != nil {
			return fmt.Errorf("pending result contains invalid lifecycle fields")
		}
		return nil
	}
	if result.State != "terminal" || result.Output == nil || result.Decision == nil || result.Competitors == nil || result.Comparisons == nil {
		return fmt.Errorf("terminal result is incomplete")
	}
	out := result.Output
	if out.ContractVersion != "1" || out.FunctionID != "market-signal.report" || out.FunctionVersion != "1" {
		return fmt.Errorf("terminal result function identity is invalid")
	}
	if out.RequestID != expectedRequestID {
		return fmt.Errorf("terminal result request id does not match the caller")
	}
	if !publicIDPattern.MatchString(expectedPublicID) || !domainPattern.MatchString(out.PrimaryDomain) || strings.TrimSpace(out.RunID) == "" {
		return fmt.Errorf("terminal result report identity is invalid")
	}
	startedAt, startedErr := time.Parse(time.RFC3339Nano, out.StartedAt)
	finishedAt, finishedErr := time.Parse(time.RFC3339Nano, out.FinishedAt)
	if startedErr != nil || finishedErr != nil || finishedAt.Before(startedAt) {
		return fmt.Errorf("terminal result timestamps are invalid")
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
	decisionDomains := make(map[string]bool, len(result.Decision.CompetitorDomains))
	for _, domain := range result.Decision.CompetitorDomains {
		if !domainPattern.MatchString(domain) || decisionDomains[domain] {
			return fmt.Errorf("decision competitor domains are invalid or duplicated")
		}
		decisionDomains[domain] = true
	}
	for _, competitor := range result.Competitors.Items {
		if !decisionDomains[competitor.Domain] {
			return fmt.Errorf("decision competitor domains do not match the authoritative roll-up")
		}
	}
	if err := validateCompetitors(*result.Competitors, m.CompetitorCount, result.Comparisons.TotalCount, out.Status == "complete" || out.Status == "limited"); err != nil {
		return err
	}
	if err := validateComparisons(*result.Comparisons, expectedPublicID, out.PrimaryDomain, result.Competitors.Items, out.FinishedAt, out.Status == "complete" || out.Status == "limited"); err != nil {
		return err
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

func validateCompetitors(competitors Competitors, expectedCount, comparisonTotal int, successful bool) error {
	if competitors.TotalCount != len(competitors.Items) || competitors.TotalCount != expectedCount {
		return fmt.Errorf("competitor roll-up does not match terminal metrics")
	}
	if competitors.Authoritative != successful {
		return fmt.Errorf("competitor authority does not match terminal status")
	}
	seen := make(map[string]bool, len(competitors.Items))
	counted := 0
	for _, competitor := range competitors.Items {
		if !domainPattern.MatchString(competitor.Domain) || strings.TrimSpace(competitor.Name) == "" || competitor.ComparisonCount < 1 || seen[competitor.Domain] {
			return fmt.Errorf("competitor roll-up contains invalid identity or counts")
		}
		seen[competitor.Domain] = true
		counted += competitor.ComparisonCount
		expectedShare := 0.0
		if comparisonTotal > 0 {
			expectedShare = math.Round(float64(competitor.ComparisonCount)/float64(comparisonTotal)*10000) / 100
		}
		if math.Abs(competitor.ComparisonSharePercent-expectedShare) > 0.001 || strings.TrimSpace(competitor.Relationship) == "" || strings.TrimSpace(competitor.Confidence) == "" || strings.TrimSpace(competitor.Reason) == "" {
			return fmt.Errorf("competitor roll-up contains inconsistent details")
		}
		if competitor.VerificationScore != nil && (*competitor.VerificationScore < 0 || *competitor.VerificationScore > 100) {
			return fmt.Errorf("competitor verification score is outside its bounds")
		}
		if competitor.WebsiteURL != nil && !validHTTPURL(*competitor.WebsiteURL) {
			return fmt.Errorf("competitor website is not a public HTTP URL")
		}
	}
	if counted != comparisonTotal {
		return fmt.Errorf("competitor comparison counts do not cover the published comparisons")
	}
	return nil
}

func validateComparisons(comparisons Comparisons, publicReportID, primaryDomain string, competitors []Competitor, finishedAt string, successful bool) error {
	if comparisons.PageURL != "/api/reports/"+publicReportID+"/result/comparisons" {
		return fmt.Errorf("comparison page is not bound to the requested report")
	}
	if comparisons.Authoritative != successful {
		return fmt.Errorf("comparison authority does not match terminal status")
	}
	expectedReturned := comparisons.TotalCount
	if expectedReturned > 50 {
		expectedReturned = 50
	}
	if comparisons.ReturnedCount != len(comparisons.Items) || comparisons.ReturnedCount != expectedReturned || comparisons.DirectPriceCount > comparisons.TotalCount {
		return fmt.Errorf("returned comparisons exceed their bounded total")
	}
	if successful && (comparisons.TotalCount > comparisons.ReturnedCount) != (comparisons.NextCursor != nil) {
		return fmt.Errorf("comparison continuation cursor does not match truncation")
	}
	if comparisons.NextCursor != nil {
		parts := strings.Split(*comparisons.NextCursor, "~")
		if len(parts) != 3 || parts[0] != publicReportID || !domainPattern.MatchString(parts[1]) || !matchIDPattern.MatchString(parts[2]) {
			return fmt.Errorf("comparison continuation cursor is not bound to the requested report")
		}
	}
	if !successful && (comparisons.ReturnedCount != 0 || comparisons.TotalCount != 0 || comparisons.DirectPriceCount != 0 || comparisons.ManifestHash != "" || comparisons.NextCursor != nil) {
		return fmt.Errorf("failed result claims authoritative comparison facts")
	}
	competitorDomains := make(map[string]bool, len(competitors))
	for _, competitor := range competitors {
		competitorDomains[competitor.Domain] = true
	}
	seen := make(map[string]bool, len(comparisons.Items))
	for _, comparison := range comparisons.Items {
		if !matchIDPattern.MatchString(comparison.ID) || seen[comparison.ID] {
			return fmt.Errorf("comparison ids are missing or duplicated")
		}
		seen[comparison.ID] = true
		if err := validateProduct(comparison.PrimaryProduct, finishedAt); err != nil {
			return fmt.Errorf("comparison %s primary product: %w", comparison.ID, err)
		}
		if err := validateProduct(comparison.RivalProduct, finishedAt); err != nil {
			return fmt.Errorf("comparison %s rival product: %w", comparison.ID, err)
		}
		if comparison.PrimaryProduct.Domain != primaryDomain || comparison.RivalProduct.Domain == primaryDomain || !competitorDomains[comparison.RivalProduct.Domain] {
			return fmt.Errorf("comparison %s is not bound to the report and competitor roll-up", comparison.ID)
		}
		if err := validateMatch(comparison.Match); err != nil {
			return fmt.Errorf("comparison %s match: %w", comparison.ID, err)
		}
		if err := validatePriceComparison(comparison.PriceComparison, comparison.PrimaryProduct.Price, comparison.RivalProduct.Price); err != nil {
			return fmt.Errorf("comparison %s price comparison: %w", comparison.ID, err)
		}
		if comparison.Recommendation.Source != "ai" && comparison.Recommendation.Source != "deterministic" && comparison.Recommendation.Source != "unknown" {
			return fmt.Errorf("comparison %s recommendation source is invalid", comparison.ID)
		}
		hasRecommendation := comparison.Recommendation.Action != nil || comparison.Recommendation.Rationale != nil
		if (comparison.Recommendation.Source == "unknown") == hasRecommendation {
			return fmt.Errorf("comparison %s recommendation content and source disagree", comparison.ID)
		}
		if comparison.Recommendation.Source == "ai" && (comparison.Recommendation.Model == nil || comparison.Recommendation.PromptVersion == nil) {
			return fmt.Errorf("comparison %s AI recommendation provenance is incomplete", comparison.ID)
		}
	}
	return nil
}

func validateProduct(product Product, finishedAt string) error {
	if strings.TrimSpace(product.ID) == "" || strings.TrimSpace(product.Title) == "" || !domainPattern.MatchString(product.Domain) || !validHTTPURL(product.SourceURL) || strings.TrimSpace(product.Price.Display) == "" {
		return fmt.Errorf("identity, source, or displayed price is missing")
	}
	parsedSource, _ := url.Parse(product.SourceURL)
	if strings.TrimPrefix(strings.ToLower(parsedSource.Hostname()), "www.") != product.Domain {
		return fmt.Errorf("source host does not match product domain")
	}
	if product.ImageURL != nil && !validHTTPURL(*product.ImageURL) {
		return fmt.Errorf("image is not a public HTTP URL")
	}
	observed, observedErr := time.Parse(time.RFC3339Nano, product.ObservedAt)
	finished, finishedErr := time.Parse(time.RFC3339Nano, finishedAt)
	if observedErr != nil || finishedErr != nil || observed.After(finished.Add(24*time.Hour)) || observed.Before(finished.Add(-366*24*time.Hour)) {
		return fmt.Errorf("observed timestamp is invalid")
	}
	if product.Price.Amount <= 0 {
		return fmt.Errorf("price amount is not positive")
	}
	if !currencyPattern.MatchString(product.Price.Currency) {
		return fmt.Errorf("price currency is invalid")
	}
	if product.Quantity != nil && (strings.TrimSpace(product.Quantity.Kind) == "" || strings.TrimSpace(product.Quantity.Unit) == "" || product.Quantity.Amount <= 0) {
		return fmt.Errorf("quantity is invalid")
	}
	return nil
}

func validateMatch(match Match) error {
	if strings.TrimSpace(match.Verdict) == "" || strings.TrimSpace(match.Method) == "" || strings.TrimSpace(match.ClaimType) == "" {
		return fmt.Errorf("classification is incomplete")
	}
	if match.Confidence < 0 || match.Confidence > 1 || match.Score < 0 || match.Score > 1 {
		return fmt.Errorf("score is outside zero-to-one bounds")
	}
	if (match.Verdict == "search_result") != (match.Method == "direct-web-search") || (match.Verdict != "search_result" && match.Method != "ai-hybrid") {
		return fmt.Errorf("verdict and method disagree")
	}
	return nil
}

func validatePriceComparison(price PriceComparison, primary, rival Price) error {
	validKinds := map[string]bool{"direct": true, "unit-normalized": true, "listed-gap": true, "listed-equal": true, "approved-unparsed": true, "both-observed": true, "one-observed": true, "none-observed": true}
	validPositions := map[string]bool{"primary_lower": true, "rival_lower": true, "equal": true, "not_calculable": true}
	if !validKinds[price.Kind] || !validPositions[price.Position] || strings.TrimSpace(price.Summary) == "" {
		return fmt.Errorf("kind, position, or summary is invalid")
	}
	if price.Currency != nil && !currencyPattern.MatchString(*price.Currency) {
		return fmt.Errorf("currency is invalid")
	}
	for _, amount := range []*float64{price.PrimaryAmount, price.RivalAmount, price.UnitBasis, price.PrimaryUnitAmount, price.RivalUnitAmount} {
		if amount != nil && *amount <= 0 {
			return fmt.Errorf("observed amount is not positive")
		}
	}
	for _, gap := range []*float64{price.GapAmount, price.GapPercent} {
		if gap != nil && *gap < 0 {
			return fmt.Errorf("gap is negative")
		}
	}
	if price.PrimaryAmount != nil && math.Abs(*price.PrimaryAmount-primary.Amount) > 0.000001 {
		return fmt.Errorf("primary amount disagrees with the product price")
	}
	if price.RivalAmount != nil && math.Abs(*price.RivalAmount-rival.Amount) > 0.000001 {
		return fmt.Errorf("rival amount disagrees with the product price")
	}
	switch price.Kind {
	case "direct":
		if price.Currency == nil || *price.Currency != primary.Currency || *price.Currency != rival.Currency || price.PrimaryAmount == nil || price.RivalAmount == nil || price.GapAmount == nil || price.GapPercent == nil || price.UnavailableReason != nil || price.UnitBasis != nil || price.Unit != nil {
			return fmt.Errorf("direct price fields are incomplete")
		}
		expectedGap := math.Round(math.Abs(primary.Amount-rival.Amount)*1_000_000) / 1_000_000
		expectedPercent := 0.0
		if primary.Amount != rival.Amount {
			expectedPercent = math.Round(math.Abs(primary.Amount-rival.Amount) / math.Max(primary.Amount, rival.Amount) * 100)
		}
		if math.Abs(*price.GapAmount-expectedGap) > 0.000001 || math.Abs(*price.GapPercent-expectedPercent) > 0.001 {
			return fmt.Errorf("direct price gap is inconsistent")
		}
		expectedPosition := "equal"
		if primary.Amount < rival.Amount {
			expectedPosition = "primary_lower"
		} else if rival.Amount < primary.Amount {
			expectedPosition = "rival_lower"
		}
		if price.Position != expectedPosition {
			return fmt.Errorf("direct price position is inconsistent")
		}
	case "unit-normalized":
		if price.Currency == nil || price.PrimaryAmount == nil || price.RivalAmount == nil || price.GapAmount == nil || price.GapPercent == nil || price.UnitBasis == nil || price.Unit == nil || price.PrimaryUnitAmount == nil || price.RivalUnitAmount == nil || price.UnavailableReason != nil {
			return fmt.Errorf("unit-normalized price fields are incomplete")
		}
	case "listed-gap":
		if price.Currency == nil || price.GapAmount == nil || price.GapPercent != nil || price.Position == "equal" || price.Position == "not_calculable" || price.UnavailableReason != nil {
			return fmt.Errorf("listed price gap fields are inconsistent")
		}
	case "listed-equal":
		if price.Currency == nil || price.Position != "equal" || price.GapAmount != nil || price.GapPercent != nil || price.UnavailableReason != nil {
			return fmt.Errorf("listed equal price fields are inconsistent")
		}
	case "approved-unparsed", "both-observed", "one-observed", "none-observed":
		if price.Position != "not_calculable" || price.GapAmount != nil || price.GapPercent != nil || price.UnavailableReason == nil {
			return fmt.Errorf("unavailable price fields are inconsistent")
		}
	}
	return nil
}

func validHTTPURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Hostname() != "" && parsed.Scheme == "https"
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
