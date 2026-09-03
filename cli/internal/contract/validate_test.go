package contract

import "testing"

const validReport = `{
  "ok": true,
  "live": true,
  "primaryDomain": "example.com",
  "results": [{
    "domain": "example.com",
    "role": "primary",
    "pages": [],
    "products": [],
    "gaps": [],
    "coverage": {"pagesRequested": 1, "pagesFetched": 1, "maxPages": 5, "robotsChecked": true},
    "fetchedAt": "2026-07-15T10:00:00Z"
  }],
  "document": {
    "version": "1",
    "generatedAt": "2026-07-15T10:00:00Z",
    "blocks": [{"type": "summary", "id": "scan-summary"}]
  },
  "crawl": {"maxPagesPerDomain": 5, "robotsAware": true, "generatedAt": "2026-07-15T10:00:00Z"}
}`

func TestReportContract(t *testing.T) {
	validator, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	if err := validator.Validate(Report, []byte(validReport)); err != nil {
		t.Fatalf("valid report rejected: %v", err)
	}
	invalid := []byte(`{"ok":true,"live":true}`)
	if err := validator.Validate(Report, invalid); err == nil {
		t.Fatal("expected incomplete report to fail validation")
	}
}

func TestReportComparisonPageContract(t *testing.T) {
	validator, err := NewValidator()
	if err != nil {
		t.Fatal(err)
	}
	valid := []byte(`{
  "schemaVersion": "1",
  "requestId": "orchestrator:test:001",
  "publicReportId": "0123456789abcdef0123456789abcdef",
  "authoritative": true,
  "manifestHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "totalCount": 0,
  "returnedCount": 0,
  "items": [],
  "nextCursor": null
}`)
	if err := validator.Validate(ReportComparisonPage, valid); err != nil {
		t.Fatalf("valid comparison page rejected: %v", err)
	}
	invalid := []byte(`{"schemaVersion":"1","authoritative":true,"items":[]}`)
	if err := validator.Validate(ReportComparisonPage, invalid); err == nil {
		t.Fatal("expected incomplete comparison page to fail validation")
	}
}
