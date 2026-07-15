package cmd

import "fmt"

type ExitError struct {
	Code  int
	Err   error
	Quiet bool
}

func (e *ExitError) Error() string {
	if e.Err == nil {
		return fmt.Sprintf("command exited with status %d", e.Code)
	}
	return e.Err.Error()
}

func (e *ExitError) Unwrap() error { return e.Err }
