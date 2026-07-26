import { access } from "node:fs/promises";

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
