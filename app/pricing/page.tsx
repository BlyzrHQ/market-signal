import Link from "next/link";
import { BrandMark } from "../components/brand-mark";
import { SiteFooter } from "../components/site-footer";

const plans = [
  { name: "Starter", price: "$8", reports: "5", products: "20", domains: "1", seats: "1", feature: "Manual refreshes", arFeature: "تحديثات يدوية", state: "early" },
  { name: "Solo", price: "$29", reports: "10", products: "50", domains: "3", seats: "1", feature: "Monthly scheduling", arFeature: "جدولة شهرية", state: "early" },
  { name: "Growth", price: "$79", reports: "40", products: "500", domains: "10", seats: "3", feature: "Exports, sharing, weekly scheduling", arFeature: "تصدير ومشاركة وجدولة أسبوعية", state: "planned" },
  { name: "Agency", price: "$199", reports: "120", products: "1,000", domains: "30", seats: "10", feature: "Client workspaces and branded exports", arFeature: "مساحات عملاء وتصدير بعلامتك", state: "planned" },
];

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const ar = (await searchParams).lang === "ar";
  return <main className="standalone-page" lang={ar ? "ar" : "en"} dir={ar ? "rtl" : "ltr"}>
    <header className="standalone-nav shell"><Link className="brand" href={ar ? "/?lang=ar" : "/"} aria-label="Market Signal home"><BrandMark /><span className="brand-name"><b>Market</b> Signal</span></Link><nav><Link href={ar ? "/how-it-works?lang=ar" : "/how-it-works"}>{ar ? "كيف يعمل" : "How it works"}</Link><Link href={ar ? "/?lang=ar#proof" : "/#proof"}>{ar ? "دليل المنتج" : "Product proof"}</Link><Link href={ar ? "/pricing" : "/pricing?lang=ar"}>{ar ? "English" : "العربية"}</Link><Link href={ar ? "/?lang=ar" : "/"}>{ar ? "حلّل نطاقاً ←" : "Analyze a domain →"}</Link></nav></header>
    <section className="standalone-hero shell"><span>{ar ? "الخطط والأسعار" : "PLANS & PRICING"}</span><h1>{ar ? "ادفع مقابل عمق الكتالوج الذي تحتاج إليه فعلاً." : "Pay for the catalog depth you actually need."}</h1><p>{ar ? "كل تشغيل ينشئ تقريراً محفوظاً. حدود المنتجات تصف عدد منتجاتك التي نقيمها أمام المنافسين المحتملين، وليست وعداً بعدد مطابقات مقبولة." : "Every run creates a saved report. Product limits describe how many of your products we assess against possible rivals—not a guaranteed number of accepted matches."}</p></section>
    <section className="standalone-pricing shell">{plans.map((plan, index) => <article className={index === 0 ? "featured" : ""} key={plan.name}><span>{plan.state === "early" ? (ar ? "وصول مبكر" : "EARLY ACCESS") : (ar ? "قريباً" : "COMING SOON")}</span><h2>{plan.name}</h2><strong>{plan.price}<small>{ar ? " / شهر" : " / month"}</small></strong><ul><li><b>{plan.reports}</b> {ar ? "تقارير مكتملة شهرياً" : "completed reports / month"}</li><li><b>{plan.products}</b> {ar ? "منتجاً يتم تحليله في التقرير" : "products analyzed / report"}</li><li><b>{plan.domains}</b> {ar ? "نطاقات مراقبة" : "monitored domains"} · <b>{plan.seats}</b> {ar ? "مقاعد" : "seats"}</li><li>{ar ? plan.arFeature : plan.feature}</li><li>{ar ? "تقارير محفوظة مرتبطة بالمصادر" : "Saved, source-linked reports"}</li></ul><Link href={ar ? "/?lang=ar" : "/"}>{plan.state === "early" ? (ar ? "ابدأ في النسخة التجريبية" : "Start in beta") : (ar ? "جرّب النسخة التجريبية" : "Try the beta")} →</Link></article>)}</section>
    <section className="self-hosted-plan shell"><div><span>{ar ? "إصدار المصدر مخطط" : "SOURCE RELEASE PLANNED"}</span><strong>{ar ? "إصدار للاستضافة الذاتية" : "Self-hosted edition"}</strong></div><p>{ar ? "المستودع في معاينة خاصة حتى اكتمال مراجعة الترخيص والأمان؛ لا ندّعي أن الإصدار العام متاح بعد." : "The repository remains in private preview until licensing and security review are complete; the public source release is not available yet."}</p><a href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">{ar ? "معاينة GitHub الخاصة" : "Private GitHub preview"} ↗</a></section>
    <p className="pricing-truth shell">{ar ? "هذه أهداف أسعار إطلاق وليست فواتير نشطة بعد. لا توجد رسوم تجاوز مفاجئة." : "Launch pricing targets only; billing is not active yet. No surprise overage charges."}</p><SiteFooter locale={ar ? "ar" : "en"} />
  </main>;
}
