package contract

import (
	"bytes"
	"encoding/json"
	"fmt"

	contractfiles "github.com/abdullabostani/market-signal/contracts"
	jsonschema "github.com/santhosh-tekuri/jsonschema/v5"
)

const (
	Report = "report"
	Ads    = "ads"
)

var schemaFiles = map[string]string{
	Report: "report.v1.schema.json",
	Ads:    "ads.v1.schema.json",
}

type Validator struct {
	schemas map[string]*jsonschema.Schema
}

func NewValidator() (*Validator, error) {
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft2020
	compiler.AssertFormat = true

	for _, name := range []string{"evidence.v1.schema.json", "report.v1.schema.json", "ads.v1.schema.json"} {
		data, err := contractfiles.Files.ReadFile(name)
		if err != nil {
			return nil, fmt.Errorf("read embedded contract %s: %w", name, err)
		}
		uri := "https://marketsignal.dev/contracts/" + name
		if err := compiler.AddResource(uri, bytes.NewReader(data)); err != nil {
			return nil, fmt.Errorf("register contract %s: %w", name, err)
		}
	}

	validator := &Validator{schemas: make(map[string]*jsonschema.Schema, len(schemaFiles))}
	for kind, name := range schemaFiles {
		schema, err := compiler.Compile("https://marketsignal.dev/contracts/" + name)
		if err != nil {
			return nil, fmt.Errorf("compile %s contract: %w", kind, err)
		}
		validator.schemas[kind] = schema
	}
	return validator, nil
}

func (v *Validator) Validate(kind string, data []byte) error {
	schema, ok := v.schemas[kind]
	if !ok {
		return fmt.Errorf("unknown contract %q", kind)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		return fmt.Errorf("decode JSON: %w", err)
	}
	if err := schema.Validate(value); err != nil {
		return fmt.Errorf("%s contract drift: %w", kind, err)
	}
	return nil
}
