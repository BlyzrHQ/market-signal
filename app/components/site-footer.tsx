import Link from "next/link";
import { BrandMark } from "./brand-mark";

export function SiteFooter({ locale = "en" }: { locale?: "en" | "ar" }) {
  const ar = locale === "ar";
  return (
    <footer className="landing-footer">
      <div className="shell landing-footer-grid">
        <div className="footer-brand-block">
          <Link className="brand" href={ar ? "/?lang=ar" : "/"} aria-label="Market Signal home">
            <BrandMark />
            <span className="brand-name"><b>Market</b> Signal</span>
          </Link>
          <p>{ar ? "حوّل إشارات السوق العامة إلى قرارات منتجات أوضح." : "Turn public market signals into clearer product decisions."}</p>
          <span className="footer-status"><i /> {ar ? "النسخة التجريبية متاحة" : "Beta access is open"}</span>
        </div>
        <div>
          <strong>{ar ? "المنتج" : "Product"}</strong>
          <Link href={ar ? "/?lang=ar#proof" : "/#proof"}>{ar ? "تقرير نموذجي" : "Report proof"}</Link>
          <Link href={ar ? "/how-it-works?lang=ar" : "/how-it-works"}>{ar ? "كيف يعمل" : "How it works"}</Link>
          <Link href={ar ? "/pricing?lang=ar" : "/pricing"}>{ar ? "الأسعار" : "Pricing"}</Link>
        </div>
        <div>
          <strong>{ar ? "المصادر" : "Resources"}</strong>
          <a href="https://github.com/BlyzrHQ/market-signal" target="_blank" rel="noreferrer">GitHub ↗</a>
          <a href="https://myjam.co.uk" target="_blank" rel="noreferrer">{ar ? "كتالوج MyJam المصدر" : "MyJam source catalog"} ↗</a>
        </div>
        <div>
          <strong>{ar ? "ابدأ" : "Get started"}</strong>
          <Link className="footer-cta" href={ar ? "/?lang=ar#top" : "/#top"}>{ar ? "حلّل نطاقك" : "Analyze your domain"} →</Link>
          <small>{ar ? "مصادر عامة فقط. كل نتيجة مرتبطة بدليل." : "Public sources only. Every result stays tied to evidence."}</small>
        </div>
      </div>
      <div className="shell footer-bottom"><span>© 2026 Market Signal</span><span>{ar ? "معلومات عامة، أصبحت مفيدة." : "Public intelligence, made useful."}</span></div>
    </footer>
  );
}
