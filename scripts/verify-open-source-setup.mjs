import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requiredFiles = [
  "README.md",
  "CONTRIBUTING.md",
  "LICENSE",
  ".env.example",
  "package-lock.json",
  "cli/go.mod",
  "cli/go.sum",
];

for (const file of requiredFiles) {
  if (!existsSync(resolve(root, file))) throw new Error(`Open-source setup is missing ${file}.`);
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
if (!packageJson.scripts?.dev || !packageJson.scripts?.test) {
  throw new Error("package.json must expose the documented dev and test commands.");
}

const port = await availablePort();
const origin = `http://localhost:${port}`;
const logs = [];
const sensitiveEnvironment = [
  "OPENAI_API_KEY",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_REF",
  "TRIGGER_API_URL",
  "MARKET_SIGNAL_CALLBACK_TOKEN",
  "MARKET_SIGNAL_API_TOKEN",
  "MARKET_SIGNAL_OWNER_READ_TOKEN",
  "MARKET_SIGNAL_OWNER_WRITE_TOKEN",
  "MARKET_SIGNAL_MONITOR_READ_TOKEN",
  "MARKET_SIGNAL_MONITOR_ACK_TOKEN",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_SOLO",
  "STRIPE_PRICE_GROWTH",
  "STRIPE_PRICE_AGENCY",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_API_VERSION",
  "SHOPIFY_TOKEN_ENCRYPTION_ACTIVE_KEY_VERSION",
  "SHOPIFY_TOKEN_ENCRYPTION_KEYS_JSON",
  "MARKET_SIGNAL_SQLITE_PATH",
];
const environment = {
  ...process.env,
  MARKET_SIGNAL_HOSTED_BILLING: "false",
  MARKET_SIGNAL_SHOPIFY_APP: "false",
  MARKET_SIGNAL_DEPLOY_TARGET: "",
};
for (const name of sensitiveEnvironment) environment[name] = "";

const cli = resolve(root, "node_modules", "vinext", "dist", "cli.js");
if (!existsSync(cli)) throw new Error("vinext is missing. Run npm ci before the setup smoke test.");

const triggerConfig = readFileSync(resolve(root, "trigger.config.ts"), "utf8");
if (!triggerConfig.includes("TRIGGER_PROJECT_REF")) {
  throw new Error("Trigger.dev must be configured from the installation-owned TRIGGER_PROJECT_REF.");
}
if (/project\s*:\s*["']proj_(?!replace_with_your_own)[A-Za-z0-9]+["']/.test(triggerConfig)) {
  throw new Error("The repository must not ship a concrete hosted Trigger.dev project reference.");
}

const child = spawn(process.execPath, [cli, "dev", "--port", String(port)], {
  cwd: root,
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
child.stdout.on("data", rememberLogs);
child.stderr.on("data", rememberLogs);

try {
  const home = await waitForResponse(`${origin}/`, 90_000);
  assertStatus(home, 200, "/");
  const homeText = await home.text();
  if (!homeText.includes("Market Signal")) throw new Error("The home page did not render the product shell.");

  for (const path of ["/pricing", "/account"]) {
    assertStatus(await fetch(`${origin}${path}`), 200, path);
  }

  const auth = await fetch(`${origin}/api/auth/get-session`);
  assertStatus(auth, 503, "/api/auth/get-session");
  const authBody = await auth.json();
  if (authBody?.code !== "account_auth_not_configured") {
    throw new Error("Unconfigured account auth did not fail closed with its documented diagnostic.");
  }

  const shopify = await fetch(`${origin}/shopify?shop=example.myshopify.com`);
  assertStatus(shopify, 503, "/shopify");
  const shopifyBody = await shopify.json();
  if (shopifyBody?.code !== "shopify_not_configured") {
    throw new Error("The dormant Shopify surface did not fail closed with its documented diagnostic.");
  }

  console.log(`Open-source startup smoke passed at ${origin} with no private credentials.`);
} catch (error) {
  const detail = logs.length ? `\n\nRecent server output:\n${logs.join("\n")}` : "";
  throw new Error(`${error instanceof Error ? error.message : String(error)}${detail}`);
} finally {
  await stopChild(child);
}

function rememberLogs(chunk) {
  logs.push(...String(chunk).split(/\r?\n/).filter(Boolean));
  if (logs.length > 80) logs.splice(0, logs.length - 80);
}

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "localhost", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a local test port."));
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

async function waitForResponse(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Local server exited before startup with code ${child.exitCode}.`);
    try {
      return await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw new Error(`Local server did not answer within ${timeoutMs / 1_000} seconds.`);
}

function assertStatus(response, expected, path) {
  if (response.status !== expected) throw new Error(`${path} returned HTTP ${response.status}; expected ${expected}.`);
}

async function stopChild(processHandle) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => processHandle.once("exit", resolveExit)),
    new Promise((resolveWait) => setTimeout(resolveWait, 5_000)),
  ]);
  if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
}
