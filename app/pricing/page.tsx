import Link from "next/link";
import { SiteFooter } from "../components/site-footer";
import { CheckoutButton } from "../components/checkout-button";
import { hostedBillingEnabled } from "../lib/billing-plans";

const plans = [
  { id: "starter", name: "Starter", price: "$8", reports: "5", products: "20" },
  { id: "solo", name: "Solo", price: "$29", reports: "10", products: "50" },
  { id: "growth", name: "Growth", price: "$79", reports: "40", products: "500" },
  { id: "agency", name: "Agency", price: "$199", reports: "120", products: "1,000" },
];

export default async function PricingPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const ar = (await searchParams).lang === "ar";
  const billingEnabled = hostedBillingEnabled();
  return <main className="standalone-page" lang={ar ? "ar" : "en"} dir={ar ? "rtl" : "ltr"}>
    <header className="standalone-nav shell"><Link className="brand" href={ar ? "/?lang=ar" : "/"}><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link><nav><Link href={ar ? "/how-it-works?lang=ar" : "/how-it-works"}>{ar ? "كيف يعمل" : "How it works"}</Link><Link href={ar ? "/?lang=ar#proof" : "/#proof"}>{ar ? "دليل المنتج" : "Product proof"}</Link><Link href={ar ? "/pricing" : "/pricing?lang=ar"}>{ar ? "English" : "العربية"}</Link><Link href={ar ? "/?lang=ar" : "/"}>{ar ? "حلّل نطاقاً ←" : "Analyze a domain →"}</Link></nav></header>
    <section className="standalone-hero shell"><span>{ar ? "الخطط والأسعار" : "PLANS & PRICING"}</span><h1>{ar ? "ادفع مقابل عمق الكتالوج الذي تحتاج إليه فعلاً." : "Pay for the catalog depth you actually need."}</h1><p>{ar ? "كل تشغيل ينشئ تقريراً محفوظاً. حدود المنتجات تصف عدد منتجاتك التي نقيمها أمام المنافسين المحتملين، وليست وعداً بعدد مطابقات مقبولة." : "Every run creates a saved report. Product limits describe how many of your products we assess against possible rivals—not a guaranteed number of accepted matches."}</p></section>
    <section className="standalone-pricing shell">{plans.map((plan, index) => <article className={index === 0 ? "featured" : ""} key={plan.name}><span>{ar ? "اشتراك شهري" : "MONTHLY PLAN"}</span><h2>{plan.name}</h2><strong>{plan.price}<small>{ar ? " / شهر" : " / month"}</small></strong><ul><li><b>{plan.reports}</b> {ar ? "تقارير مكتملة شهرياً" : "completed reports / month"}</li><li><b>{plan.products}</b> {ar ? "منتجاً يتم تحليله في التقرير" : "products analyzed / report"}</li><li>{ar ? "تقارير محفوظة مرتبطة بالمصادر" : "Saved, source-linked reports"}</li><li>{ar ? "إدارة الاشتراك ذاتياً عبر بوابة الفوترة" : "Self-service subscription management"}</li></ul>{billingEnabled ? <CheckoutButton plan={plan.id} label={ar ? `اختر ${plan.name}` : `Choose ${plan.name}`} /> : <p>{ar ? "الفوترة المستضافة غير مفعلة في هذا النشر." : "Hosted billing is not enabled on this deployment."}</p>}</article>)}</section>
    <section className="self-hosted-plan shell"><div><span>{ar ? "إصدار المصدر مخطط" : "SOURCE RELEASE PLANNED"}</span><strong>{ar ? "إصدار للاستضافة الذاتية" : "Self-hosted edition"}</strong></div><p>{ar ? "المستودع في معاينة خاصة حتى اكتمال مراجعة الترخيص والأمان؛ لا ندّعي أن الإصدار العام متاح بعد." : "The repository remains in private preview until licensing and security review are complete; the public source release is not available yet."}</p><a href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">{ar ? "معاينة GitHub الخاصة" : "Private GitHub preview"} ↗</a></section>
    <p className="pricing-truth shell">{ar ? "لا توجد رسوم تجاوز تلقائية. تتوقف التقارير الجديدة عند بلوغ حد خطتك حتى دورة الفوترة التالية أو تغيير الخطة." : "No automatic overage charges. New reports pause at your plan limit until the next billing period or a plan change."}</p><SiteFooter locale={ar ? "ar" : "en"} />
  </main>;
}
