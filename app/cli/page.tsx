import Link from "next/link";

const reportCommand = "marketsignal-internal report example.com --comparisons 20 --request-id orchestrator:example:001 --output json";
const waitCommand = "marketsignal-internal wait <public-report-id> --request-id orchestrator:example:001 --output json";
const resultCommand = "marketsignal-internal result <public-report-id> --request-id orchestrator:example:001 --output json";

export default function CliPage() {
  return <main className="standalone-page cli-page">
    <div className="shell">
      <header className="standalone-nav">
        <Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link>
        <nav><a href="#commands">Commands</a><a href="#output">Output</a></nav>
      </header>
      <section className="standalone-hero cli-hero">
        <span>MARKET SIGNAL · COMPANY CLI</span>
        <h1>A domain in. Comparison data out.</h1>
        <p>Call Market Signal from your terminal or another company agent. Submit a domain, then receive structured competitors, priced product comparisons, and evaluation status. No browser sign-in or customer account setup.</p>
      </section>
      <section className="cli-steps" id="commands" aria-label="Company CLI commands">
        <article><span>01</span><div><h2>Request a report</h2><p>On a company-provisioned machine, run this command. Replace the domain and choose a unique request ID for each new report. This example requests 20 comparison pairs; it is not a live result or a guarantee of 20 matches.</p><pre><code>{reportCommand}</code></pre></div></article>
        <article><span>02</span><div><h2>Wait for the same report</h2><p>If the response is pending, use its public report ID and the same request ID to continue waiting. Do not submit a fresh request just because your terminal stopped waiting.</p><pre><code>{waitCommand}</code></pre></div></article>
        <article><span>03</span><div><h2>Retrieve the output</h2><p>Read the current JSON snapshot without waiting. Replace <code>&lt;public-report-id&gt;</code> with the ID returned by the first command; the ID does not make the report publicly accessible.</p><pre><code>{resultCommand}</code></pre></div></article>
      </section>
      <section className="method-truth cli-truth" id="output">
        <strong>WHAT YOUR AGENT RECEIVES</strong>
        <p>The versioned JSON response includes request and run IDs, pending or terminal state, competitor roll-ups, priced comparison rows, coverage, evaluation status, limitations, and provider cost when known. Missing cost remains unknown—not zero. Check the returned status and coverage before treating a report as complete.</p>
      </section>
      <section className="method-truth cli-truth">
        <strong>WHAT RUNS BEHIND THE COMMAND</strong>
        <p>The internal CLI sends the request to our report service, which dispatches the work to Trigger.dev. The CLI reads the durable result back from that service. It does not run the research on your laptop or call Trigger directly. Reuse the same request ID for a retry of the same work; a new ID represents a new request and can incur new costs.</p>
      </section>
      <section className="cli-steps" aria-label="One-time machine setup">
        <article><span>SETUP</span><div><h2>Prepare a company machine once</h2><p>Get the <code>marketsignal-internal</code> executable from your company operator and put it on your PATH. Confirm it is available:</p><pre><code>marketsignal-internal version</code></pre><p>If the machine is not already provisioned, import the scoped company credential supplied by your operator at the hidden prompt. This is machine setup, not a website login. Never paste a production Trigger key here or put credentials in command arguments.</p><pre><code>marketsignal-internal configure</code></pre><p>After setup, agents only need the report, wait, and result commands above. Server-side access rules and usage controls still apply.</p></div></article>
      </section>
    </div>
  </main>;
}
