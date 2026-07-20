export async function runtimeEnvironmentValue(name: string, override?: string) {
  if (typeof override === "string") return override.trim();
  try {
    const workers = await import("cloudflare:workers");
    const value = (workers.env as Record<string, unknown>)[name];
    if (typeof value === "string") return value.trim();
  } catch { /* Node tests and local tooling do not expose Cloudflare bindings. */ }
  return String(process.env[name] || "").trim();
}
