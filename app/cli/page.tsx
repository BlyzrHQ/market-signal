import Link from "next/link";

const installCommand = "irm https://signal.blyzr.com/install.ps1 | iex";

export default function CliPage() {
  return <main className="standalone-page cli-page">
    <div className="shell">
      <header className="standalone-nav">
        <Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link>
        <nav><Link href="/how-it-works">How it works</Link><Link href="/pricing">Pricing</Link><Link href="/account">Your account</Link></nav>
      </header>
      <section className="standalone-hero cli-hero">
        <span>MARKET SIGNAL CLI · WINDOWS PREVIEW</span>
        <h1>Your reports, directly from the terminal.</h1>
        <p>Install once, connect through your browser or a scoped workspace API key, then submit any public domain. Reports stay private in the Market Signal workspace that authorized the CLI.</p>
      </section>
      <section className="cli-steps" aria-label="CLI setup">
        <article><span>01</span><div><h2>Install</h2><p>Open PowerShell and paste this command.</p><pre><code>{installCommand}</code></pre></div></article>
        <article><span>02</span><div><h2>Sign in</h2><p>Your browser opens Market Signal. Approve only the displayed report permissions; your password never enters the CLI.</p><pre><code>marketsignal login</code></pre></div></article>
        <article><span>03</span><div><h2>Run a report</h2><p>The command submits once, waits for the private report, and prints competitors and priced product comparisons.</p><pre><code>marketsignal report example.com</code></pre></div></article>
      </section>
      <section className="method-truth cli-truth">
        <strong>CONNECTING AN AGENT</strong>
        <p>Create a revocable key under <Link href="/account">Account → API keys</Link>, set <code>MARKET_SIGNAL_API_KEY</code>, and run <code>marketsignal report example.com --output json</code>. Or save it in Windows Credential Manager with <code>marketsignal login --api-key</code>. Never place a key directly in the command line.</p>
      </section>
      <section className="method-truth cli-truth">
        <strong>WHAT THIS INSTALLS</strong>
        <p>A Windows binary in your user profile. Saved credentials live in Windows Credential Manager, report access is limited to your workspace, and <code>marketsignal logout</code> revokes the saved OAuth grant or API key. This preview is not yet code-signed, so Windows may ask you to confirm the first launch.</p>
        <a href="/downloads/marketsignal-windows-amd64.exe">Direct x64 download</a>
        <span> · </span>
        <a href="/downloads/marketsignal-windows-arm64.exe">Direct Arm64 download</a>
        <span> · </span>
        <a href="/downloads/SHA256SUMS.txt">Checksums</a>
      </section>
    </div>
  </main>;
}
