import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("hosted CLI distribution supports the simple login flow and scoped agent keys", async () => {
  const [page, guide, readme, installer, dockerfile, root] = await Promise.all([
    readFile(new URL("../app/cli/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/CLI.md", import.meta.url), "utf8"),
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../public/install.ps1", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../cli/internal/cmd/root.go", import.meta.url), "utf8"),
  ]);

  for (const source of [page, guide, readme]) {
    assert.match(source, /marketsignal login/);
    assert.match(source, /marketsignal report example\.com/);
    assert.doesNotMatch(source, /Current distribution boundary/);
  }
  assert.match(root, /defaultBaseURL = oauth\.ProductionOrigin/);
  assert.match(root, /MARKET_SIGNAL_API_KEY/);
  assert.match(guide, /marketsignal login --api-key/);
  assert.match(guide, /never append the key/i);
  assert.match(installer, /System\.Security\.Cryptography\.SHA256/);
  assert.match(installer, /ComputeHash\(\$fileStream\)/);
  assert.match(installer, /Windows Credential Manager|Next: marketsignal login/i);
  assert.match(installer, /SetEnvironmentVariable\("Path", \$nextPath, "User"\)/);
  assert.match(dockerfile, /GOOS=windows GOARCH=amd64/);
  assert.match(dockerfile, /GOOS=windows GOARCH=arm64/);
  assert.match(dockerfile, /sha256sum marketsignal-windows-amd64\.exe marketsignal-windows-arm64\.exe/);
  assert.match(dockerfile, /-X main\.version=\$\{MARKET_SIGNAL_REVISION\}/);
});

test("installer refuses remote plaintext downloads and verifies before install", async () => {
  const installer = await readFile(new URL("../public/install.ps1", import.meta.url), "utf8");
  const downloadIndex = installer.indexOf("Invoke-WebRequest");
  const verifyIndex = installer.indexOf("$actualChecksum");
  const installIndex = installer.indexOf("Move-Item");
  assert.ok(downloadIndex >= 0 && verifyIndex > downloadIndex && installIndex > verifyIndex);
  assert.match(installer, /\$downloadBase\.Scheme -ne "https"/);
  assert.match(installer, /-and -not \$downloadBase\.IsLoopback/);
  assert.match(installer, /50MB/);
  assert.match(installer, /64KB/);
});

test("installer retries the complete verification transaction and validates the .NET hash result", async () => {
  const installer = await readFile(new URL("../public/install.ps1", import.meta.url), "utf8");

  assert.match(installer, /function Invoke-VerifiedDownloadWithRetry/);
  assert.match(installer, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
  assert.match(installer, /\$null -eq \$hashBytes/);
  assert.match(installer, /\$hashBytes\.Length -ne 32/);
  assert.doesNotMatch(installer, /Get-FileHash/);
  assert.match(installer, /could not be verified after 3 attempts/i);
  assert.ok(installer.indexOf("$actualChecksum") < installer.indexOf("return\n      } catch"));
});
