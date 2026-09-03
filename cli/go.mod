module github.com/abdullabostani/market-signal/cli

go 1.22.0

require (
	github.com/abdullabostani/market-signal/contracts v0.0.0
	github.com/santhosh-tekuri/jsonschema/v5 v5.3.1
	github.com/spf13/cobra v1.10.2
	github.com/zalando/go-keyring v0.2.6
	golang.org/x/term v0.25.0
)

replace github.com/abdullabostani/market-signal/contracts => ../contracts

require (
	al.essio.dev/pkg/shellescape v1.5.1 // indirect
	github.com/danieljoos/wincred v1.2.2 // indirect
	github.com/godbus/dbus/v5 v5.1.0 // indirect
	github.com/inconshreveable/mousetrap v1.1.0 // indirect
	github.com/spf13/pflag v1.0.9 // indirect
	golang.org/x/sys v0.26.0 // indirect
)
