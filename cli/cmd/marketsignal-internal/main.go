package main

import (
	"errors"
	"fmt"
	"os"

	marketcmd "github.com/abdullabostani/market-signal/cli/internal/cmd"
)

var version = "dev"

func main() {
	if err := marketcmd.NewInternalRoot(version).Execute(); err != nil {
		var exitErr *marketcmd.ExitError
		if errors.As(err, &exitErr) {
			if !exitErr.Quiet {
				fmt.Fprintln(os.Stderr, exitErr.Error())
			}
			os.Exit(exitErr.Code)
		}
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
