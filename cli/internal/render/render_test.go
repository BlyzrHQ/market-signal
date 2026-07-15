package render

import (
	"bytes"
	"strings"
	"testing"
)

func TestAdsTableDoesNotRenderLimitedCoverageAsZero(t *testing.T) {
	data := []byte(`{"ok":true,"block":{"primaryDomain":"example.com","provider":"official-links-only","companies":[{"domain":"example.com","platforms":[{"platform":"Meta","status":"access-limited","activeCreativeCount":0}]}],"limitation":"API approval is pending."}}`)
	var output bytes.Buffer
	limited, err := AdsTable(&output, data)
	if err != nil {
		t.Fatal(err)
	}
	if !limited || !strings.Contains(output.String(), "not established") {
		t.Fatalf("limited coverage was not made explicit:\n%s", output.String())
	}
}

func TestReportTableCountsDiscoveryLaneGaps(t *testing.T) {
	data := []byte(`{"primaryDomain":"example.com","results":[],"document":{"blocks":[{"type":"market-profile","gaps":["Entity search timed out","Product search timed out"]}]}}`)
	var output bytes.Buffer
	gaps, err := ReportTable(&output, data, false)
	if err != nil {
		t.Fatal(err)
	}
	if !gaps || !strings.Contains(output.String(), "DECLARED GAPS  2") {
		t.Fatalf("discovery lane gaps were not counted:\n%s", output.String())
	}
}
