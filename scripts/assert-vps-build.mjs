import { access, readFile } from "node:fs/promises";

const cloudflareMetadata = new URL("../dist/server/wrangler.json", import.meta.url);

try {
  await access(cloudflareMetadata);
  throw new Error("The VPS build unexpectedly contains Cloudflare wrangler metadata.");
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    process.stdout.write("VPS build assertion passed: no Cloudflare wrangler metadata.\n");
  } else {
    throw error;
  }
}

const serverEntry = new URL("../dist/server/index.js", import.meta.url);
const serverSource = await readFile(serverEntry, "utf8");
if (serverSource.includes("Could not locate the bindings file. Tried")) {
  throw new Error(
    "The VPS build bundled better-sqlite3's native binding loader instead of leaving the package external.",
  );
}
if (!serverSource.includes('"better-sqlite3"')) {
  throw new Error("The VPS build does not retain the expected better-sqlite3 runtime import.");
}

process.stdout.write("VPS build assertion passed: better-sqlite3 remains external.\n");
