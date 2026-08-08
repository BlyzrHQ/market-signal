import Link from "next/link";
import { SiteFooter } from "../components/site-footer";

const plans = [
  { name: "Starter", price: "$8", runs: "5 reports / month", products: "20 products / report", note: "A simple way to map one small catalog." },
  { name: "Solo", price: "$29", runs: "10 reports / month", products: "50 products / report", note: "For an operator tracking a broader shelf." },
  { name: "Growth", price: "Coming soon", runs: "Team reporting", products: "500 products / report", note: "For growing ecommerce teams and scheduled monitoring." },
  { name: "Agency", price: "Coming soon", runs: "Multi-client reporting", products: "1,000 products / report", note: "For deep catalogs and client workspaces." },
];

export default function PricingPage() {
  return <main className="standalone-page"><header className="standalone-nav shell"><Link className="brand" href="/"><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link><nav><Link href="/how-it-works">How it works</Link><Link href="/#proof">Product proof</Link><Link href="/">Analyze a domain →</Link></nav></header><section className="standalone-hero shell"><span>PLANS & PRICING</span><h1>Pay for the catalog depth you actually need.</h1><p>Every run creates a saved report. Product limits describe how many of your products we assess against possible rivals—not a guaranteed number of accepted matches.</p></section><section className="standalone-pricing shell">{plans.map((plan, index) => <article className={index === 0 ? "featured" : ""} key={plan.name}><span>{index < 2 ? "EARLY ACCESS" : "PLANNED"}</span><h2>{plan.name}</h2><strong>{plan.price}</strong><p>{plan.note}</p><ul><li>{plan.runs}</li><li>{plan.products}</li><li>Saved, source-linked reports</li></ul><Link href="/">{index < 2 ? "Start in beta" : "Try the beta"} →</Link></article>)}</section><p className="pricing-truth shell">Launch pricing targets only; billing is not active yet. No surprise overage charges.</p><SiteFooter /></main>;
}
