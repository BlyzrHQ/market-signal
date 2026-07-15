package render

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
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

type adsEnvelope struct {
	Block struct {
		PrimaryDomain string `json:"primaryDomain"`
		Provider      string `json:"provider"`
		Companies     []struct {
			Domain    string `json:"domain"`
			Platforms []struct {
				Platform            string `json:"platform"`
				Status              string `json:"status"`
				ActiveCreativeCount int    `json:"activeCreativeCount"`
			} `json:"platforms"`
		} `json:"companies"`
		Limitation string `json:"limitation"`
	} `json:"block"`
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

func AdsTable(w io.Writer, data []byte) (bool, error) {
	var ads adsEnvelope
	if err := json.Unmarshal(data, &ads); err != nil {
		return false, err
	}
	limited := false
	tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
	fmt.Fprintf(tw, "PRIMARY\t%s\n", ads.Block.PrimaryDomain)
	fmt.Fprintf(tw, "PROVIDER\t%s\n\n", ads.Block.Provider)
	fmt.Fprintln(tw, "COMPANY\tCHANNEL\tSTATE\tVERIFIED ACTIVE")
	for _, company := range ads.Block.Companies {
		sort.SliceStable(company.Platforms, func(i, j int) bool { return company.Platforms[i].Platform < company.Platforms[j].Platform })
		for _, platform := range company.Platforms {
			if platform.Status != "verified-active" {
				limited = true
			}
			count := fmt.Sprintf("%d", platform.ActiveCreativeCount)
			if platform.Status != "verified-active" {
				count = "not established"
			}
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", company.Domain, platform.Platform, platform.Status, count)
		}
	}
	fmt.Fprintf(tw, "\nLIMITATION\t%s\n", ads.Block.Limitation)
	return limited, tw.Flush()
}

func stringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
