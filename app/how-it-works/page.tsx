import Link from "next/link";
import { SiteFooter } from "../components/site-footer";

const enSteps = [
  ["01", "Build your catalog", "Crawl public pages, product feeds, sitemaps, structured data, prices, and images."],
  ["02", "Discover by product", "Use product identities and regional signals to find companies selling real alternatives."],
  ["03", "Match with AI", "Retrieve likely pairs, then judge brand, variant, size, and contradictions with bounded AI calls."],
  ["04", "Verify commercial proof", "Re-read selected product pages and publish only rivals with a valid public price."],
  ["05", "Save the decision", "Persist the report, sources, catalog, competitors, comparisons, and visible coverage gaps."],
];
const arSteps = [
  ["01", "نبني كتالوجك", "نزحف الصفحات العامة وخلاصات المنتجات وخرائط الموقع والبيانات المنظمة والأسعار والصور."],
  ["02", "نكتشف عبر المنتج", "نستخدم هوية المنتجات والإشارات الإقليمية للعثور على شركات تبيع بدائل حقيقية."],
  ["03", "نطابق بالذكاء الاصطناعي", "نسترجع الأزواج المحتملة ثم نقيم العلامة والمتغير والحجم والتناقضات ضمن طلبات محدودة."],
  ["04", "نتحقق من الدليل التجاري", "نعيد قراءة صفحات المنتجات المختارة ولا ننشر إلا منافسين لديهم سعر عام صالح."],
  ["05", "نحفظ القرار", "نحفظ التقرير والمصادر والكتالوج والمنافسين والمقارنات وفجوات التغطية الظاهرة."],
];

export default async function HowItWorksPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const ar = (await searchParams).lang === "ar";
  const steps = ar ? arSteps : enSteps;
  return <main className="standalone-page" lang={ar ? "ar" : "en"} dir={ar ? "rtl" : "ltr"}>
    <header className="standalone-nav shell"><Link className="brand" href={ar ? "/?lang=ar" : "/"}><span className="brand-mark"><i /><i /><i /></span><span>Market Signal</span></Link><nav><Link href={ar ? "/pricing?lang=ar" : "/pricing"}>{ar ? "الأسعار" : "Pricing"}</Link><Link href={ar ? "/?lang=ar#proof" : "/#proof"}>{ar ? "دليل المنتج" : "Product proof"}</Link><Link href={ar ? "/how-it-works" : "/how-it-works?lang=ar"}>{ar ? "English" : "العربية"}</Link><Link href={ar ? "/?lang=ar" : "/"}>{ar ? "حلّل نطاقاً ←" : "Analyze a domain →"}</Link></nav></header>
    <section className="standalone-hero shell"><span>{ar ? "كيف يعمل" : "HOW IT WORKS"}</span><h1>{ar ? "المنتجات تقود البحث. والأدلة تقرر ما ننشره." : "Products lead the search. Evidence decides what ships."}</h1><p>{ar ? "لا نطلب منك إدخال المنافسين. نبدأ بكتالوجك العام، ونبحث في السوق حول منتجاته، ونُبقي عدم اليقين ظاهراً." : "Market Signal does not ask you to list competitors. It starts with your public catalog, searches the market around those products, and keeps uncertainty visible."}</p></section>
    <section className="process-page shell">{steps.map(([number,title,copy]) => <article key={number}><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></article>)}</section>
    <section className="method-truth shell"><strong>{ar ? "ما لا نفعله أبداً" : "What we never do"}</strong><p>{ar ? "لا نخترع الأسعار، ولا نحوّل التغطية المفقودة إلى صفر، ولا ننشر منتج منافس مقبولاً دون سعر عام موجب وعملة مدعومة." : "We do not invent prices, call missing coverage zero, or publish an accepted competitor product without a finite positive public price and a supported currency."}</p><a href="https://myjam.co.uk" target="_blank" rel="noreferrer">{ar ? "افتح كتالوج MyJam المصدر" : "Inspect the MyJam source catalog"} ↗</a></section><SiteFooter locale={ar ? "ar" : "en"} />
  </main>;
}
