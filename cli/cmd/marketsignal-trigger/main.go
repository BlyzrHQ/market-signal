package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/abdullabostani/market-signal/cli/internal/triggercli"
)

var version = "dev"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := triggercli.NewRoot(version).ExecuteContext(ctx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(triggercli.ExitCode(err))
	}
}
