import vinext from "vinext";
import { defineConfig } from "vite";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(() => {
  const nodeRuntimeExternals = {
    name: "market-signal:node-runtime-externals",
    enforce: "pre" as const,
    resolveId(source: string) {
      if (source === "better-sqlite3") {
        return { id: source, external: true };
      }
      return null;
    },
  };
  return {
    ssr: {
      external: ["better-sqlite3"],
    },
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      nodeRuntimeExternals,
      vinext(),
    ],
  };
});
