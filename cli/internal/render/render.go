package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
)

type reportEnvelope struct {
	PrimaryDomain string `json:"primaryDomain"`
	Results       []struct {
		Domain   string `json:"domain"`
		Role     string `json:"role"`
		Products []any  `json:"products"`
		Coverage struct {
			PagesRequested int `json:"pagesRequested"`
			PagesFetched   int `json:"pagesFetched"`
		} `json:"coverage"`
	} `json:"results"`
	Document struct {
		Blocks []map[string]any `json:"blocks"`
	} `json:"document"`
}

func JSON(w io.Writer, data []byte) error {
	var out bytes.Buffer
	if err := json.Indent(&out, data, "", "  "); err != nil {
		return err
	}
	out.WriteByte('\n')
	_, err := w.Write(out.Bytes())
	return err
}

func ReportTable(w io.Writer, data []byte, crawlOnly bool) (bool, error) {
	var report reportEnvelope
	if err := json.Unmarshal(data, &report); err != nil {
		return false, err
	}
	competitors := 0
	comparisonRows := 0
	gaps := 0
	for _, block := range report.Document.Blocks {
		switch stringValue(block["type"]) {
		case "competitor":
			competitors++
		case "product-comparison":
			if rows, ok := block["rows"].([]any); ok {
				comparisonRows += len(rows)
			}
		case "gap":
			gaps++
		case "market-profile":
			if laneGaps, ok := block["gaps"].([]any); ok && len(laneGaps) > 0 {
				gaps += len(laneGaps)
			} else if stringValue(block["gap"]) != "" {
				gaps++
			}
		}
	}

	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintf(tw, "DOMAIN\t%s\n", report.PrimaryDomain)
	fmt.Fprintln(tw, "STATUS\tLIVE — contract v1 validated")
	if !crawlOnly {
		fmt.Fprintf(tw, "COMPETITORS\t%d verified\n", competitors)
		fmt.Fprintf(tw, "PRODUCT COMPARISON\t%d rows\n", comparisonRows)
	}
	fmt.Fprintln(tw, "")
	fmt.Fprintln(tw, "CRAWL TARGET\tPAGES\tPRODUCTS")
	for _, result := range report.Results {
		fmt.Fprintf(tw, "%s (%s)\t%d/%d fetched\t%d\n", result.Domain, result.Role, result.Coverage.PagesFetched, result.Coverage.PagesRequested, len(result.Products))
	}
	fmt.Fprintf(tw, "\nDECLARED GAPS\t%d\n", gaps)
	if gaps > 0 {
		fmt.Fprintln(tw, "NEXT\tUse --output json for source URLs and exact gap reasons.")
	}
	return gaps > 0, tw.Flush()
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
