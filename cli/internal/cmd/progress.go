package cmd

import (
	"fmt"
	"io"
	"time"
)

func startProgress(w io.Writer, quiet bool, action string) func() {
	if quiet {
		return func() {}
	}
	started := time.Now()
	fmt.Fprintf(w, "%s…\n", action)
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				fmt.Fprintf(w, "Still working — %s elapsed…\n", time.Since(started).Round(time.Second))
			case <-done:
				return
			}
		}
	}()
	return func() {
		close(done)
		<-stopped
		fmt.Fprintf(w, "Finished in %s.\n", time.Since(started).Round(time.Millisecond))
	}
}
