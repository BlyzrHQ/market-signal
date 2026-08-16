export async function runtimeEnvironmentValue(name: string, override?: string) {
  if (typeof override === "string") return override.trim();
  return String(process.env[name] || "").trim();
}
