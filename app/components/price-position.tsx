import { formatPriceClaim, resolvePriceClaim } from "../lib/price-claims";

type Locale = "en" | "ar";

type PricePositionProps = {
  comparisonValue: unknown;
  primaryRaw: string;
  rivalRaw: string;
  priceVerdict: string;
  locale: Locale;
  primaryQuantity?: unknown;
  rivalQuantity?: unknown;
  showDetail?: boolean;
  showValues?: boolean;
};

const TEXT = {
  en: {
    aria: "Observed price position",
    label: "PRICE POSITION",
    you: "YOU",
    rival: "RIVAL",
    notObserved: "Not observed",
  },
  ar: {
    aria: "موقع السعر المرصود",
    label: "موقع السعر",
    you: "أنت",
    rival: "المنافس",
    notObserved: "غير مرصود",
  },
};

export function PricePosition({ comparisonValue, primaryRaw, rivalRaw, locale, primaryQuantity, rivalQuantity, showDetail = true, showValues = true }: PricePositionProps) {
  const copy = TEXT[locale];
  const claim = resolvePriceClaim({ comparisonValue, primaryRaw, rivalRaw, primaryQuantity, rivalQuantity });
  const claimCopy = formatPriceClaim(claim, locale);
  const primaryDisplay = claim.primaryRaw || primaryRaw || copy.notObserved;
  const rivalDisplay = claim.rivalRaw || rivalRaw || copy.notObserved;

  return (
    <section className={`price-position-panel ${claimCopy.tone}${showValues ? "" : " comparison-only"}`} aria-label={copy.aria}>
      <div className="price-position-grid">
        {showValues && <div className="price-position-value your-position-value">
          <span>{copy.you}</span>
          <strong dir="auto">{primaryDisplay}</strong>
        </div>}
        <div className="price-position-result">
          <span>{copy.label}</span>
          <strong dir="auto">{claimCopy.headline}</strong>
          {claimCopy.supporting && <b dir="auto">{claimCopy.supporting}</b>}
        </div>
        {showValues && <div className="price-position-value rival-position-value">
          <span>{copy.rival}</span>
          <strong dir="auto">{rivalDisplay}</strong>
        </div>}
      </div>
      {showDetail && <p dir="auto">{claimCopy.detail}</p>}
    </section>
  );
}
