import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const installerPath = fileURLToPath(new URL("../public/install.ps1", import.meta.url));
const windowsOnly = process.platform === "win32" ? test : test.skip;

function runPowerShell(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      ...args,
    ], { env: { ...process.env, ...extraEnv } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

windowsOnly("the documented irm pipe works in PowerShell 5.1 without leaking installer helpers", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "market-signal-installer-test-"));
  const sourceBinary = path.join(process.env.WINDIR, "System32", "where.exe");
  const goodBinary = await readFile(sourceBinary);
  const checksum = createHash("sha256").update(goodBinary).digest("hex");
  const assetName = process.arch === "arm64" ? "marketsignal-windows-arm64.exe" : "marketsignal-windows-amd64.exe";
  let hostedInstaller = "";

  try {
    const result = await withInstallerServer((request, response) => {
      let body;
      let contentType;
      if (request.url === "/install.ps1") {
        body = Buffer.from(hostedInstaller);
        contentType = "text/plain";
      } else if (request.url === `/downloads/${assetName}`) {
        body = goodBinary;
        contentType = "application/octet-stream";
      } else if (request.url === "/downloads/SHA256SUMS.txt") {
        body = Buffer.from(`${checksum}  ${assetName}\n`);
        contentType = "text/plain";
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": body.length });
      response.end(body);
    }, async (baseUrl) => {
      hostedInstaller = (await readFile(installerPath, "utf8"))
        .replace(/\r?\n/g, "\r\n")
        .replace("https://signal.blyzr.com/downloads", `${baseUrl}/downloads`)
        .replace(/\[switch\]\$SkipPathUpdate\r?\n\)/, "[switch]$SkipPathUpdate = $true\n)");
      const command = [
        "function Invoke-VerifiedDownloadWithRetry { 'sentinel' }",
        `irm '${baseUrl}/install.ps1' | iex`,
        "if ((Invoke-VerifiedDownloadWithRetry) -ne 'sentinel') { throw 'Installer helper leaked into the caller scope.' }",
      ].join("; ");
      return runPowerShell(["-Command", command], { LOCALAPPDATA: workspace });
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /installed successfully/i);
    assert.deepEqual(
      await readFile(path.join(workspace, "Programs", "MarketSignal", "marketsignal.exe")),
      goodBinary,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

async function withInstallerServer(handler, action) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port } = server.address();
    return await action(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

windowsOnly("PowerShell 5.1 retries a non-empty corrupted binary as a complete verification transaction", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "market-signal-installer-test-"));
  const sourceBinary = path.join(process.env.WINDIR, "System32", "where.exe");
  const goodBinary = await readFile(sourceBinary);
  const badBinary = goodBinary.subarray(0, Math.max(1, Math.floor(goodBinary.length / 2)));
  const checksum = createHash("sha256").update(goodBinary).digest("hex");
  const assetName = process.arch === "arm64" ? "marketsignal-windows-arm64.exe" : "marketsignal-windows-amd64.exe";
  let binaryRequests = 0;

  try {
    const result = await withInstallerServer((request, response) => {
      if (request.url === `/${assetName}`) {
        binaryRequests += 1;
        const body = binaryRequests === 1 ? badBinary : goodBinary;
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
        response.end(body);
        return;
      }
      if (request.url === "/SHA256SUMS.txt") {
        const body = `${checksum}  ${assetName}\n`;
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    }, (baseUrl) => runPowerShell([
      "-File", installerPath,
      "-BaseUrl", baseUrl,
      "-InstallDirectory", workspace,
      "-SkipPathUpdate",
    ]));

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /installed successfully/i);
    assert.equal(binaryRequests, 2);
    assert.deepEqual(await readFile(path.join(workspace, "marketsignal.exe")), goodBinary);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

windowsOnly("PowerShell 5.1 retries a malformed manifest and fails safely after three bad checksums", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "market-signal-installer-test-"));
  const sourceBinary = path.join(process.env.WINDIR, "System32", "where.exe");
  const goodBinary = await readFile(sourceBinary);
  const checksum = createHash("sha256").update(goodBinary).digest("hex");
  const assetName = process.arch === "arm64" ? "marketsignal-windows-arm64.exe" : "marketsignal-windows-amd64.exe";
  let manifestRequests = 0;

  try {
    const recovered = await withInstallerServer((request, response) => {
      if (request.url === `/${assetName}`) {
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": goodBinary.length });
        response.end(goodBinary);
        return;
      }
      if (request.url === "/SHA256SUMS.txt") {
        manifestRequests += 1;
        const body = manifestRequests === 1 ? "malformed\n" : `${checksum}  ${assetName}\n`;
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    }, (baseUrl) => runPowerShell([
      "-File", installerPath,
      "-BaseUrl", baseUrl,
      "-InstallDirectory", workspace,
      "-SkipPathUpdate",
    ]));

    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    assert.equal(manifestRequests, 2);

    await copyFile(sourceBinary, path.join(workspace, "marketsignal.exe"));
    let binaryRequests = 0;
    const failed = await withInstallerServer((request, response) => {
      if (request.url === `/${assetName}`) {
        binaryRequests += 1;
        const body = Buffer.from("corrupt-but-non-empty");
        response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
        response.end(body);
        return;
      }
      if (request.url === "/SHA256SUMS.txt") {
        const body = `${checksum}  ${assetName}\n`;
        response.writeHead(200, { "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      response.writeHead(404).end();
    }, (baseUrl) => runPowerShell([
      "-File", installerPath,
      "-BaseUrl", baseUrl,
      "-InstallDirectory", workspace,
      "-SkipPathUpdate",
    ]));

    assert.notEqual(failed.code, 0);
    assert.equal(binaryRequests, 3);
    assert.match(`${failed.stdout}\n${failed.stderr}`, /could not be verified after 3 attempts/i);
    assert.deepEqual(await readFile(path.join(workspace, "marketsignal.exe")), goodBinary);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
