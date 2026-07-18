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
  },
  ar: {
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

export function PricePosition({ comparisonValue, primaryRaw, rivalRaw, priceVerdict, locale }: PricePositionProps) {
  const copy = TEXT[locale];
  const comparison = resolvedPriceDelta(comparisonValue);
  const primaryDisplay = comparison?.primaryRaw || primaryRaw || copy.notObserved;
  const rivalDisplay = comparison?.rivalRaw || rivalRaw || copy.notObserved;
  let headline = copy.unavailable;
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
      <p dir="auto">{comparison ? copy.method : priceVerdict || copy.unavailableDetail}</p>
    </section>
  );
}
