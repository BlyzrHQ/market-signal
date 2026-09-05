package triggercli

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/zalando/go-keyring"
	"golang.org/x/term"
)

const service = "Market Signal Direct Trigger CLI"

type exitError struct {
	code    int
	message string
}

func (e *exitError) Error() string { return e.message }
func ExitCode(err error) int {
	var e *exitError
	if errors.As(err, &e) {
		return e.code
	}
	return 1
}

type credentialStore interface {
	Get() (string, error)
	Set(string) error
	Delete() error
}
type osStore struct{}

func (osStore) Get() (string, error) { return keyring.Get(service, origin) }
func (osStore) Set(key string) error { return keyring.Set(service, origin, key) }
func (osStore) Delete() error        { return keyring.Delete(service, origin) }

type options struct {
	store   credentialStore
	env     func(string) string
	connect func(string) (*Client, error)
}

func NewRoot(version string) *cobra.Command {
	return newRoot(version, options{osStore{}, os.Getenv, newClient})
}

func domainInput(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Port() != "" {
		return "", fmt.Errorf("provide your public store domain")
	}
	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	if net.ParseIP(host) != nil || !regexp.MustCompile(`^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`).MatchString(host) || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") {
		return "", fmt.Errorf("provide your public store domain; no preset domain is supplied")
	}
	return host, nil
}

func newRoot(version string, o options) *cobra.Command {
	root := &cobra.Command{Use: "marketsignal-trigger", Short: "Run Market Signal directly in your Trigger project", SilenceUsage: true, SilenceErrors: true}
	var workerVersion string
	root.PersistentFlags().StringVar(&workerVersion, "worker-version", "", "operator testing: pin a deployed Trigger version without promoting it")
	client := func() (*Client, error) {
		if workerVersion != "" && !regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`).MatchString(workerVersion) {
			return nil, fmt.Errorf("invalid worker version")
		}
		key := strings.TrimSpace(o.env("TRIGGER_SECRET_KEY"))
		if key == "" {
			var err error
			key, err = o.store.Get()
			if err != nil {
				return nil, fmt.Errorf("run marketsignal-trigger configure or securely set TRIGGER_SECRET_KEY")
			}
		}
		cl, err := o.connect(key)
		if err == nil {
			cl.workerVersion = workerVersion
		}
		return cl, err
	}
	root.AddCommand(&cobra.Command{Use: "version", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error { fmt.Fprintln(c.OutOrStdout(), version); return nil }})
	var stdin bool
	configure := &cobra.Command{Use: "configure", Short: "Verify and securely save your Trigger environment API key", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
		var data []byte
		var err error
		if stdin {
			data, err = io.ReadAll(io.LimitReader(c.InOrStdin(), 513))
		} else {
			f, ok := c.InOrStdin().(*os.File)
			if !ok || !term.IsTerminal(int(f.Fd())) {
				return fmt.Errorf("use configure in a terminal or securely pipe the key with --stdin")
			}
			fmt.Fprint(c.ErrOrStderr(), "Trigger environment API key (hidden): ")
			data, err = term.ReadPassword(int(f.Fd()))
			fmt.Fprintln(c.ErrOrStderr())
		}
		if err != nil || len(data) > 512 {
			return fmt.Errorf("cannot read bounded credential")
		}
		key := strings.TrimSpace(string(data))
		cl, err := o.connect(key)
		if err != nil {
			return err
		}
		if err = cl.verify(c.Context()); err != nil {
			return err
		}
		if err = o.store.Set(key); err != nil {
			return fmt.Errorf("OS credential store unavailable; no plaintext fallback; securely set TRIGGER_SECRET_KEY instead")
		}
		fmt.Fprintln(c.OutOrStdout(), "Trigger key verified and saved in the OS credential store. Run doctor to check installed tasks.")
		return nil
	}}
	configure.Flags().BoolVar(&stdin, "stdin", false, "read key from standard input, never a command argument")
	root.AddCommand(configure)
	root.AddCommand(&cobra.Command{Use: "logout", Short: "Delete this CLI's saved key (does not revoke it in Trigger)", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
		if err := o.store.Delete(); err != nil {
			return fmt.Errorf("could not delete saved key")
		}
		fmt.Fprintln(c.OutOrStdout(), "Saved key deleted; environment credentials are unchanged.")
		return nil
	}})
	for _, tool := range []string{"report", "crawl", "compare"} {
		tool := tool
		var count, rivals int
		var id string
		var maxWait, poll time.Duration
		var noWait bool
		command := &cobra.Command{Use: tool + " <domain>", Short: "Run the direct " + tool + " task in Trigger", Args: cobra.ExactArgs(1), RunE: func(c *cobra.Command, args []string) error {
			domain, err := domainInput(args[0])
			if err != nil {
				return err
			}
			if count < 1 || count > 1000 || rivals < 1 || rivals > 50 {
				return fmt.Errorf("comparisons must be 1..1000 and rivals 1..50 (per-run safety bounds, not daily quotas)")
			}
			if !requestPattern.MatchString(id) {
				return fmt.Errorf("provide --request-id for one logical request; reuse it only for the same input")
			}
			if maxWait <= 0 || poll <= 0 {
				return fmt.Errorf("wait durations must be positive")
			}
			cl, err := client()
			if err != nil {
				return err
			}
			run, err := cl.trigger(c.Context(), "market-signal-direct-"+tool, id, map[string]any{"contractVersion": "1", "domain": domain, "comparisons": count, "rivals": rivals, "requestId": id})
			if err != nil {
				return err
			}
			fmt.Fprintf(c.ErrOrStderr(), "Trigger run: %s\n", run)
			receipt, err := cl.retrieve(c.Context(), run)
			if err != nil {
				return err
			}
			p := receipt.Payload
			if receipt.Task != "market-signal-direct-"+tool || p["domain"] != domain || p["requestId"] != id || p["comparisons"] != float64(count) || p["rivals"] != float64(rivals) || p["contractVersion"] != "1" {
				return &exitError{9, "request ID is bound to different input or the run payload cannot be verified; inspect Trigger, do not resubmit"}
			}
			if noWait {
				return writeJSON(c, map[string]any{"runId": run, "state": "pending", "requestId": id})
			}
			fmt.Fprintln(c.ErrOrStderr(), "Report incoming. This command will show progress and return the result automatically; no separate wait command is needed.")
			return waitRun(c, cl, run, maxWait, poll)
		}}
		command.Flags().IntVar(&count, "comparisons", 20, "priced comparison-pair target (crawl: catalog output limit)")
		command.Flags().IntVar(&rivals, "rivals", 10, "maximum distinct rival domains in delivered comparisons")
		command.Flags().StringVar(&id, "request-id", "", "required unique logical request ID; Trigger deduplication expires after 24h")
		command.Flags().DurationVar(&maxWait, "max-wait", time.Hour, "wait budget; does not cancel the Trigger run")
		command.Flags().DurationVar(&poll, "poll", 15*time.Second, "status poll interval")
		command.Flags().BoolVar(&noWait, "no-wait", false, "return the Trigger run ID immediately")
		root.AddCommand(command)
	}
	for _, name := range []string{"result", "wait"} {
		name := name
		var maxWait, poll time.Duration
		command := &cobra.Command{Use: name + " <run-id>", Short: "Retrieve an existing Trigger run without starting another", Args: cobra.ExactArgs(1), RunE: func(c *cobra.Command, args []string) error {
			if !runPattern.MatchString(args[0]) {
				return fmt.Errorf("enter a Trigger run ID")
			}
			if maxWait <= 0 || poll <= 0 {
				return fmt.Errorf("wait durations must be positive")
			}
			cl, err := client()
			if err != nil {
				return err
			}
			if name == "wait" {
				return waitRun(c, cl, args[0], maxWait, poll)
			}
			r, err := cl.retrieve(c.Context(), args[0])
			if err != nil {
				return err
			}
			return displayRun(c, r)
		}}
		command.Flags().DurationVar(&maxWait, "max-wait", time.Hour, "wait budget")
		command.Flags().DurationVar(&poll, "poll", 15*time.Second, "poll interval")
		root.AddCommand(command)
	}
	for _, name := range []string{"doctor", "tools"} {
		root.AddCommand(&cobra.Command{Use: name, Short: "Run the installed capabilities task (no research-provider calls)", Args: cobra.NoArgs, RunE: func(c *cobra.Command, _ []string) error {
			cl, err := client()
			if err != nil {
				return err
			}
			var nonce [12]byte
			if _, err = rand.Read(nonce[:]); err != nil {
				return fmt.Errorf("cannot create probe ID")
			}
			id, err := cl.trigger(c.Context(), "market-signal-direct-capabilities", "probe:"+hex.EncodeToString(nonce[:]), map[string]any{})
			if err != nil {
				return err
			}
			return waitRun(c, cl, id, time.Minute, 2*time.Second)
		}})
	}
	return root
}

func writeJSON(c *cobra.Command, value any) error {
	e := json.NewEncoder(c.OutOrStdout())
	e.SetIndent("", "  ")
	return e.Encode(value)
}
func displayRun(c *cobra.Command, r Run) error {
	if r.Status == "COMPLETED" && (len(r.Output) == 0 || string(r.Output) == "null") {
		return fmt.Errorf("Trigger run completed without retrievable output; inspect the run in Trigger")
	}
	if r.Status == "COMPLETED" {
		var contract struct {
			Version string `json:"contractVersion"`
			Status  string `json:"status"`
		}
		if json.Unmarshal(r.Output, &contract) != nil || contract.Version != "1" || (contract.Status != "complete" && contract.Status != "limited" && contract.Status != "failed" && !(r.Task == "market-signal-direct-capabilities" && contract.Status == "ready")) {
			return fmt.Errorf("direct task output contract mismatch; inspect the deployed version")
		}
	}
	if err := writeJSON(c, r); err != nil {
		return err
	}
	if !terminal(r.Status) {
		return &exitError{6, "run pending; resume with wait and the same run ID"}
	}
	if r.Status != "COMPLETED" {
		return &exitError{5, "Trigger run failed; inspect it in Trigger; no automatic resubmission"}
	}
	var result struct {
		Status string `json:"status"`
	}
	_ = json.Unmarshal(r.Output, &result)
	if result.Status == "limited" {
		return &exitError{2, "report returned limited coverage"}
	}
	if result.Status == "failed" {
		return &exitError{5, "report returned failure details"}
	}
	return nil
}
func waitRun(c *cobra.Command, cl *Client, id string, maximum, poll time.Duration) error {
	ctx, cancel := context.WithTimeout(c.Context(), maximum)
	defer cancel()
	started := time.Now()
	lastStatus := ""
	lastNotice := time.Time{}
	for {
		r, err := cl.retrieve(ctx, id)
		if err != nil {
			if ctx.Err() != nil {
				_ = writeJSON(c, map[string]any{"runId": id, "state": "pending"})
				return &exitError{6, "waiting stopped; Trigger run was not canceled; resume with wait"}
			}
			return err
		}
		if terminal(r.Status) {
			fmt.Fprintf(c.ErrOrStderr(), "[%s] %s. Retrieving result.\n", time.Since(started).Round(time.Second), r.Status)
			return displayRun(c, r)
		}
		// Keep stdout a single machine-readable result. Never print arbitrary
		// provider metadata or source content as terminal control sequences.
		if r.Status != lastStatus || time.Since(lastNotice) >= 15*time.Second {
			label := "Still working"
			switch r.Status {
			case "QUEUED", "PENDING_VERSION", "DEQUEUED":
				label = "Queued in Trigger"
			case "EXECUTING":
				label = "Research running"
			case "WAITING":
				label = "Research waiting for a dependency"
			case "REATTEMPTING":
				label = "Trigger resuming the existing run"
			}
			fmt.Fprintf(c.ErrOrStderr(), "[%s] %s; result will appear here automatically.\n", time.Since(started).Round(time.Second), label)
			lastStatus, lastNotice = r.Status, time.Now()
		}
		timer := time.NewTimer(poll)
		select {
		case <-ctx.Done():
			timer.Stop()
			_ = writeJSON(c, map[string]any{"runId": id, "state": "pending"})
			return &exitError{6, "waiting stopped; resume with wait"}
		case <-timer.C:
		}
	}
}
