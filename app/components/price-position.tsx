import { resolvedPriceDelta } from "../lib/report-presentation";

type Locale = "en" | "ar";

type PricePositionProps = {
  comparisonValue: unknown;
  primaryRaw: string;
  rivalRaw: string;
  priceVerdict: string;
  locale: Locale;
};

const TEXT = {
  en: {
    aria: "Observed price position",
    label: "PRICE POSITION",
    you: "YOU",
    rival: "RIVAL",
    notObserved: "Not observed",
    equal: "Same observed price",
    underOne: "Price difference is under 1%",
    youCheaper: (percent: number) => `You are ${percent}% cheaper`,
    rivalCheaper: (percent: number) => `Rival is ${percent}% cheaper`,
    gap: (currency: string, amount: string) => `${currency} ${amount} gap`,
    method: "Percent is relative to the higher observed price.",
    unavailable: "No direct price comparison",
    unavailableDetail: "The observed prices are missing or not comparable on the same basis.",
    approvedUnparsed: "Comparable pair confirmed",
    approvedUnparsedDetail: "This pair passed the product and price-basis check, but this currency or price format could not be calculated here.",
    bothObserved: "Prices found — comparison basis unverified",
    bothObservedDetail: "Both prices are public observations. We do not call either side cheaper until variant, size, currency, billing basis, and included value align.",
    oneObserved: "Only one public price found",
    oneObservedDetail: "A price lead cannot be calculated until both products expose a public price on a comparable basis.",
    noneObserved: "No public prices found",
    noneObservedDetail: "Neither product exposed a public price that can support a comparison in this crawl.",
  },
  ar: {
    approvedUnparsed: "تم تأكيد أساس المقارنة",
    approvedUnparsedDetail: "اجتاز هذا الزوج التحقق من المنتج وأساس السعر، لكن تعذّر حساب الفرق لهذه العملة أو صيغة السعر هنا.",
    bothObserved: "تم العثور على السعرين — أساس المقارنة غير مؤكد",
    bothObservedDetail: "كلا السعرين مرصودان علناً. لا نصف أحدهما بأنه أرخص حتى تتطابق الفئة والحجم والعملة وأساس الفوترة والقيمة المشمولة.",
    oneObserved: "تم العثور على سعر عام واحد فقط",
    oneObservedDetail: "لا يمكن حساب فرق السعر حتى يعرض المنتجان سعراً عاماً على أساس قابل للمقارنة.",
    noneObserved: "لم يتم العثور على أسعار عامة",
    noneObservedDetail: "لم يعرض أي من المنتجين سعراً عاماً يدعم المقارنة في هذا الفحص.",
    aria: "موقع السعر المرصود",
    label: "موقع السعر",
    you: "أنت",
    rival: "المنافس",
    notObserved: "غير مرصود",
    equal: "السعر المرصود متساوٍ",
    underOne: "فرق السعر أقل من 1%",
    youCheaper: (percent: number) => `أنت أرخص بنسبة ${percent}%`,
    rivalCheaper: (percent: number) => `المنافس أرخص بنسبة ${percent}%`,
    gap: (currency: string, amount: string) => `فرق ${currency} ${amount}`,
    method: "تُحسب النسبة مقارنةً بالسعر المرصود الأعلى.",
    unavailable: "لا توجد مقارنة سعر مباشرة",
    unavailableDetail: "الأسعار المرصودة مفقودة أو غير قابلة للمقارنة على الأساس نفسه.",
  },
};

export function PricePosition({ comparisonValue, primaryRaw, rivalRaw, locale }: PricePositionProps) {
  const copy = TEXT[locale];
  const comparison = resolvedPriceDelta(comparisonValue);
  const primaryDisplay = comparison?.primaryRaw || primaryRaw || copy.notObserved;
  const rivalDisplay = comparison?.rivalRaw || rivalRaw || copy.notObserved;
  const approvedPair = comparisonValue !== null && comparisonValue !== undefined;
  const primaryObserved = Boolean((comparison?.primaryRaw || primaryRaw).trim());
  const rivalObserved = Boolean((comparison?.rivalRaw || rivalRaw).trim());
  let headline = primaryObserved && rivalObserved ? copy.bothObserved : primaryObserved || rivalObserved ? copy.oneObserved : copy.noneObserved;
  let detail = primaryObserved && rivalObserved ? copy.bothObservedDetail : primaryObserved || rivalObserved ? copy.oneObservedDetail : copy.noneObservedDetail;
  let tone = "unavailable";
  if (comparison) {
    headline = comparison.equal
      ? copy.equal
      : comparison.percent === 0
        ? copy.underOne
        : comparison.percent < 0
          ? copy.rivalCheaper(Math.abs(comparison.percent))
          : copy.youCheaper(comparison.percent);
    tone = comparison.equal ? "equal" : comparison.percent < 0 ? "rival-leads" : "you-lead";
    detail = copy.method;
  } else if (approvedPair) {
    headline = copy.approvedUnparsed;
    detail = copy.approvedUnparsedDetail;
    tone = "approved-unparsed";
  } else if (primaryObserved && rivalObserved) {
    tone = "basis-unverified";
  }
  const difference = comparison ? Math.abs(comparison.primary.amount - comparison.rival.amount) : 0;

  return (
    <section className={`price-position-panel ${tone}`} aria-label={copy.aria}>
      <div className="price-position-grid">
        <div className="price-position-value your-position-value">
          <span>{copy.you}</span>
          <strong dir="auto">{primaryDisplay}</strong>
        </div>
        <div className="price-position-result">
          <span>{copy.label}</span>
          <strong dir="auto">{headline}</strong>
          {comparison && !comparison.equal && <b dir="ltr">{copy.gap(comparison.primary.currency, difference.toFixed(2))}</b>}
        </div>
        <div className="price-position-value rival-position-value">
          <span>{copy.rival}</span>
          <strong dir="auto">{rivalDisplay}</strong>
        </div>
      </div>
      <p dir="auto">{detail}</p>
    </section>
  );
}
