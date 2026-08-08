import Link from "next/link";
import { SiteFooter } from "../components/site-footer";

const steps = [
  ["01", "Build your catalog", "Crawl public pages, product feeds, sitemaps, structured data, prices, and images."],
  ["02", "Discover by product", "Use product identities and regional signals to find companies selling real alternatives."],
  ["03", "Match with AI", "Retrieve likely pairs, then judge brand, variant, size, and contradictions with bounded AI calls."],
  ["04", "Verify the commercial proof", "Re-read selected product pages and publish only rivals with a valid public price."],
  ["05", "Save the decision", "Persist the report, sources, catalog, competitors, comparisons, and visible coverage gaps."],
];

export default function HowItWorksPage() {
  return <main className="standalone-page"><header className="standalone-nav shell"><Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link><nav><Link href="/pricing">Pricing</Link><Link href="/#proof">Product proof</Link><Link href="/">Analyze a domain →</Link></nav></header><section className="standalone-hero shell"><span>HOW IT WORKS</span><h1>Products lead the search. Evidence decides what ships.</h1><p>Market Signal does not ask you to list competitors. It starts with your public catalog, searches the market around those products, and keeps uncertainty visible.</p></section><section className="process-page shell">{steps.map(([number,title,copy]) => <article key={number}><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></article>)}</section><section className="method-truth shell"><strong>What we never do</strong><p>We do not invent prices, call missing coverage “zero,” or publish an accepted competitor product without a finite positive public price and a supported currency.</p><Link href="/reports/7fb305987e9a439abcbb352ee7302b26?view=products&layout=table">Inspect a real report ↗</Link></section><SiteFooter /></main>;
}
