import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const schemas = Object.fromEntries(await Promise.all([
  ["report", "report.v1.schema.json"],
  ["ads", "ads.v1.schema.json"],
].map(async ([kind, filename]) => {
  const data = await readFile(new URL(`../contracts/${filename}`, import.meta.url), "utf8");
  return [kind, JSON.parse(data)];
})));

const validators = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, ajv.compile(schema)]));

export function validateContract(kind, payload) {
  const validator = validators[kind];
  if (!validator) throw new Error(`Unknown Market Signal contract: ${kind}`);
  const valid = validator(payload);
  return {
    valid: Boolean(valid),
    errors: valid ? [] : (validator.errors || []).map((error) => `${error.instancePath || "/"} ${error.message}`).slice(0, 12),
  };
}

export function assertContract(kind, payload) {
  const result = validateContract(kind, payload);
  if (!result.valid) throw new Error(`${kind} contract drift: ${result.errors.join("; ")}`);
}
