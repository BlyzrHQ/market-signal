package render

import (
	"bytes"
	"strings"
	"testing"
)

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
