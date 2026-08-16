import type { CanonicalProductQuantity } from "./product-normalization.ts";
import { parseComparablePrice, resolvedPriceDelta, type ParsedPrice } from "./report-presentation.ts";

type PriceDirection = "primary" | "rival" | "equal";
type PriceLane = "pressure" | "advantage" | "evidence";

type PriceClaimInput = {
  comparisonValue: unknown;
  primaryRaw: string;
  rivalRaw: string;
  primaryQuantity?: unknown;
  rivalQuantity?: unknown;
};

type ClaimBase = {
  primaryRaw: string;
  rivalRaw: string;
  primary: ParsedPrice | null;
  rival: ParsedPrice | null;
};

export type PriceClaim =
  | (ClaimBase & {
    kind: "direct";
    direction: PriceDirection;
    currency: ParsedPrice["currency"];
    gap: number;
    percent: number;
    equal: boolean;
  })
  | (ClaimBase & {
    kind: "unit-normalized";
    direction: PriceDirection;
    currency: ParsedPrice["currency"];
    gap: number;
    percent: number;
    primaryUnitAmount: number;
    rivalUnitAmount: number;
    unitBasis: number;
    unit: CanonicalProductQuantity["unit"];
  })
  | (ClaimBase & {
    kind: "listed-gap";
    direction: Exclude<PriceDirection, "equal">;
    currency: ParsedPrice["currency"];
    gap: number;
  })
  | (ClaimBase & { kind: "listed-equal"; currency: ParsedPrice["currency"] })
  | (ClaimBase & { kind: "approved-unparsed" })
  | (ClaimBase & { kind: "both-observed"; reason: "currency" | "format" })
  | (ClaimBase & { kind: "one-observed"; observedSide: "primary" | "rival" })
  | (ClaimBase & { kind: "none-observed" });

export type PriceClaimCopy = {
  headline: string;
  detail: string;
  supporting: string;
  tone: string;
  lane: PriceLane;
};

export type PriceDifferenceCopy = {
  label: string;
  value: string;
  direction: string;
  note: string;
};

function roundMoney(value: number) {
  return Number(value.toFixed(6));
}

function direction(primary: number, rival: number): PriceDirection {
  return primary === rival ? "equal" : primary < rival ? "primary" : "rival";
}

function lowerPercent(primary: number, rival: number) {
  if (primary === rival) return 0;
  return primary < rival
    ? Math.round(((rival - primary) / rival) * 100)
    : Math.round(((primary - rival) / primary) * 100);
}

function quantity(value: unknown): CanonicalProductQuantity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const kind = String(record.kind);
  const unit = String(record.unit);
  const coherentUnit = (kind === "mass" && unit === "g")
    || (kind === "volume" && unit === "ml")
    || (kind === "count" && (unit === "pcs" || unit === "pack"));
  if (
    !coherentUnit
    || typeof record.amount !== "number"
    || !Number.isFinite(record.amount)
    || record.amount <= 0
  ) return null;
  return record as CanonicalProductQuantity;
}

function unitBasis(value: CanonicalProductQuantity) {
  return value.unit === "g" || value.unit === "ml" ? 100 : 1;
}

export function resolvePriceClaim({
  comparisonValue,
  primaryRaw,
  rivalRaw,
  primaryQuantity,
  rivalQuantity,
}: PriceClaimInput): PriceClaim {
  const approved = resolvedPriceDelta(comparisonValue);
  if (approved) {
    const claimDirection = direction(approved.primary.amount, approved.rival.amount);
    return {
      kind: "direct",
      primaryRaw: approved.primaryRaw,
      rivalRaw: approved.rivalRaw,
      primary: approved.primary,
      rival: approved.rival,
      direction: claimDirection,
      currency: approved.primary.currency,
      gap: roundMoney(Math.abs(approved.primary.amount - approved.rival.amount)),
      percent: Math.abs(approved.percent),
      equal: approved.equal,
    };
  }

  const primaryObserved = Boolean(primaryRaw.trim());
  const rivalObserved = Boolean(rivalRaw.trim());
  const primary = parseComparablePrice(primaryRaw);
  const rival = parseComparablePrice(rivalRaw);
  const base = { primaryRaw, rivalRaw, primary, rival };

  if (comparisonValue !== null && comparisonValue !== undefined) return { ...base, kind: "approved-unparsed" };
  if (!primaryObserved && !rivalObserved) return { ...base, kind: "none-observed" };
  if (!primaryObserved || !rivalObserved) {
    return { ...base, kind: "one-observed", observedSide: primaryObserved ? "primary" : "rival" };
  }
  if (!primary || !rival) return { ...base, kind: "both-observed", reason: "format" };
  if (primary.currency !== rival.currency) return { ...base, kind: "both-observed", reason: "currency" };

  const primaryCanonical = quantity(primaryQuantity);
  const rivalCanonical = quantity(rivalQuantity);
  const normalizable = Boolean(
    primaryCanonical
    && rivalCanonical
    && primaryCanonical.kind === rivalCanonical.kind
    && primaryCanonical.unit === rivalCanonical.unit
    && primaryCanonical.amount !== rivalCanonical.amount,
  );
  if (normalizable && primaryCanonical && rivalCanonical) {
    const basis = unitBasis(primaryCanonical);
    const primaryUnitAmount = roundMoney((primary.amount / primaryCanonical.amount) * basis);
    const rivalUnitAmount = roundMoney((rival.amount / rivalCanonical.amount) * basis);
    return {
      ...base,
      kind: "unit-normalized",
      direction: direction(primaryUnitAmount, rivalUnitAmount),
      currency: primary.currency,
      gap: roundMoney(Math.abs(primaryUnitAmount - rivalUnitAmount)),
      percent: lowerPercent(primaryUnitAmount, rivalUnitAmount),
      primaryUnitAmount,
      rivalUnitAmount,
      unitBasis: basis,
      unit: primaryCanonical.unit,
    };
  }

  const listedDirection = direction(primary.amount, rival.amount);
  if (listedDirection === "equal") return { ...base, kind: "listed-equal", currency: primary.currency };
  return {
    ...base,
    kind: "listed-gap",
    direction: listedDirection,
    currency: primary.currency,
    gap: roundMoney(Math.abs(primary.amount - rival.amount)),
  };
}

function amount(value: number) {
  return value.toFixed(2);
}

function basisLabel(claim: Extract<PriceClaim, { kind: "unit-normalized" }>) {
  return `${claim.unitBasis}${claim.unit}`;
}

export function formatPriceDifference(claim: PriceClaim, locale: "en" | "ar"): PriceDifferenceCopy {
  const ar = locale === "ar";

  if (claim.kind === "direct") {
    return {
      label: ar ? "فرق سعر متحقق" : "Verified price gap",
      value: `${claim.currency} ${amount(claim.gap)}`,
      direction: claim.equal
        ? (ar ? "السعران متساويان" : "Same price")
        : claim.percent === 0
          ? (ar ? "الفرق أقل من 1%" : "Difference is under 1%")
        : claim.direction === "rival"
          ? (ar ? `المنافس أقل بنسبة ${claim.percent}%` : `Rival is ${claim.percent}% lower`)
          : (ar ? `سعرك أقل بنسبة ${claim.percent}%` : `Your price is ${claim.percent}% lower`),
      note: ar ? "مقارنة مباشرة معتمدة" : "Verified direct comparison",
    };
  }

  if (claim.kind === "unit-normalized") {
    const basis = basisLabel(claim);
    return {
      label: ar ? `فرق السعر لكل ${basis}` : `Gap per ${basis}`,
      value: `${claim.currency} ${amount(claim.gap)}`,
      direction: claim.direction === "equal"
        ? (ar ? "سعر الوحدة متساوٍ" : "Same unit price")
        : claim.percent === 0
          ? (ar ? "فرق سعر الوحدة أقل من 1%" : "Unit-price difference is under 1%")
        : claim.direction === "rival"
          ? (ar ? `سعر وحدة المنافس أقل بنسبة ${claim.percent}%` : `Rival unit price is ${claim.percent}% lower`)
          : (ar ? `سعر وحدتك أقل بنسبة ${claim.percent}%` : `Your unit price is ${claim.percent}% lower`),
      note: ar ? "محسوب من السعر والكمية المعروضين" : "Computed from listed price and quantity",
    };
  }

  if (claim.kind === "listed-gap") {
    return {
      label: ar ? "فرق السعر المعروض" : "Listed-price gap",
      value: `${claim.currency} ${amount(claim.gap)}`,
      direction: claim.direction === "rival"
        ? (ar ? "سعر المنافس المعروض أقل" : "Rival listed price is lower")
        : (ar ? "سعرك المعروض أقل" : "Your listed price is lower"),
      note: ar ? "ليست مقارنة مماثلة؛ الحجم والنوع غير متحققين" : "Not like-for-like; pack and variant unverified",
    };
  }

  if (claim.kind === "listed-equal") {
    return {
      label: ar ? "فرق السعر المعروض" : "Listed-price gap",
      value: `${claim.currency} 0.00`,
      direction: ar ? "السعران المعروضان متساويان" : "Same listed price",
      note: ar ? "لا يثبت تكافؤ القيمة" : "Does not establish equivalent value",
    };
  }

  if (claim.kind === "both-observed") {
    return {
      label: ar ? "الفرق غير متاح" : "Gap unavailable",
      value: "—",
      direction: claim.reason === "currency"
        ? (ar ? "العملتان مختلفتان" : "Different currencies")
        : (ar ? "نطاق سعري أو صيغة غير مدعومة" : "Range or unsupported format"),
      note: ar ? "تم الاحتفاظ بالسعرين المعروضين" : "Both listed prices remain visible",
    };
  }

  if (claim.kind === "one-observed") {
    return {
      label: ar ? "الفرق غير متاح" : "Gap unavailable",
      value: "—",
      direction: ar ? "سعر واحد فقط متاح" : "Only one price is available",
      note: ar ? "يلزم سعر من الطرفين" : "Two public prices are required",
    };
  }

  return {
    label: ar ? "الفرق غير متاح" : "Gap unavailable",
    value: "—",
    direction: claim.kind === "approved-unparsed"
      ? (ar ? "تم تأكيد الزوج القابل للمقارنة" : "Comparable pair confirmed")
      : (ar ? "لم يتم العثور على أسعار عامة" : "No public prices found"),
    note: claim.kind === "approved-unparsed"
      ? (ar ? "تعذر حساب الفرق بسبب صيغة السعر أو العملة" : "Gap unavailable for this price or currency format")
      : (ar ? "يلزم سعر من الطرفين" : "Two public prices are required"),
  };
}

export function formatPriceClaim(claim: PriceClaim, locale: "en" | "ar"): PriceClaimCopy {
  const ar = locale === "ar";
  if (claim.kind === "direct") {
    const nearEqual = !claim.equal && claim.percent === 0;
    const headline = claim.equal
      ? (ar ? "السعر المرصود متساوٍ" : "Same observed price")
      : nearEqual
        ? (ar ? "فرق السعر أقل من 1%" : "Price difference is under 1%")
        : claim.direction === "rival"
          ? (ar ? `المنافس أرخص بنسبة ${claim.percent}%` : `Rival is ${claim.percent}% cheaper`)
          : (ar ? `أنت أرخص بنسبة ${claim.percent}%` : `You are ${claim.percent}% cheaper`);
    return {
      headline,
      detail: ar ? "تُحسب النسبة مقارنةً بالسعر المرصود الأعلى." : "Percent is relative to the higher observed price.",
      supporting: claim.equal ? "" : ar ? `فارق ${claim.currency} ${amount(claim.gap)}` : `${claim.currency} ${amount(claim.gap)} gap`,
      tone: claim.equal ? "equal" : nearEqual ? "near-equal" : claim.direction === "rival" ? "rival-leads" : "you-lead",
      lane: nearEqual ? "evidence" : claim.direction === "rival" ? "pressure" : "advantage",
    };
  }

  if (claim.kind === "unit-normalized") {
    const label = basisLabel(claim);
    const headline = claim.direction === "equal"
      ? (ar ? "سعر الوحدة المحسوب متساوٍ" : "Same computed unit price")
      : claim.percent === 0
        ? (ar ? "فرق سعر الوحدة أقل من 1%" : "Unit-price difference is under 1%")
        : claim.direction === "rival"
          ? (ar ? `سعر الوحدة المحسوب لدى المنافس أقل بنسبة ${claim.percent}%` : `Rival computed unit price is ${claim.percent}% lower`)
          : (ar ? `سعر الوحدة المحسوب لديك أقل بنسبة ${claim.percent}%` : `Your computed unit price is ${claim.percent}% lower`);
    return {
      headline,
      detail: ar
        ? "مقارنة محسوبة من الكمية والسعر المعروضين؛ قد يظل النوع أو المحتوى مختلفاً."
        : "Computed from the observed quantity and listed price; variant or included value may still differ.",
      supporting: ar
        ? `${claim.currency} ${amount(claim.primaryUnitAmount)}/${label} مقابل ${claim.currency} ${amount(claim.rivalUnitAmount)}/${label} · محسوب من الأسعار المعروضة`
        : `${claim.currency} ${amount(claim.primaryUnitAmount)}/${label} vs ${claim.currency} ${amount(claim.rivalUnitAmount)}/${label} · computed from listed prices`,
      tone: claim.direction === "equal" || claim.percent === 0 ? "near-equal" : claim.direction === "rival" ? "rival-leads" : "you-lead",
      lane: claim.direction === "equal" || claim.percent === 0 ? "evidence" : claim.direction === "rival" ? "pressure" : "advantage",
    };
  }

  if (claim.kind === "listed-gap") {
    return {
      headline: claim.direction === "rival"
        ? (ar ? `سعر المنافس المعروض أقل بمقدار ${claim.currency} ${amount(claim.gap)}` : `Rival listed price is ${claim.currency} ${amount(claim.gap)} lower`)
        : (ar ? `سعرك المعروض أقل بمقدار ${claim.currency} ${amount(claim.gap)}` : `Your listed price is ${claim.currency} ${amount(claim.gap)} lower`),
      detail: ar
        ? "لم يتم التحقق من تطابق الحجم والنوع، لذلك لا نعرض نسبة مئوية."
        : "Pack size and variant are not verified as aligned, so no percentage is shown.",
      supporting: "",
      tone: "basis-unverified",
      lane: "evidence",
    };
  }

  if (claim.kind === "listed-equal") {
    return {
      headline: ar ? "السعران المعروضان متساويان" : "Same listed price",
      detail: ar
        ? "لم يتم التحقق من تطابق الحجم والنوع، لذلك لا نعتبر المنتجين متكافئين."
        : "Pack size and variant are not verified as aligned, so this does not establish equivalent value.",
      supporting: "",
      tone: "basis-unverified",
      lane: "evidence",
    };
  }

  if (claim.kind === "approved-unparsed") {
    return {
      headline: ar ? "تم تأكيد أساس المقارنة" : "Comparable pair confirmed",
      detail: ar
        ? "اجتاز الزوج التحقق، لكن تعذّر حساب الفرق لهذه العملة أو صيغة السعر."
        : "The pair passed the comparison-basis check, but this currency or price format could not be calculated.",
      supporting: "",
      tone: "approved-unparsed",
      lane: "evidence",
    };
  }

  if (claim.kind === "both-observed") {
    return {
      headline: ar ? "تم رصد السعرين المعروضين" : "Both listed prices observed",
      detail: claim.reason === "currency"
        ? (ar ? "العملتان مختلفتان، لذلك لا نعرض فرقاً رقمياً." : "The currencies differ, so no numerical gap is shown.")
        : (ar ? "يتضمن أحد السعرين نطاقاً أو صيغة غير مدعومة، لذلك لا نعرض فرقاً واحداً." : "At least one value is a range or unsupported price format, so no single gap is shown."),
      supporting: "",
      tone: "basis-unverified",
      lane: "evidence",
    };
  }

  if (claim.kind === "one-observed") {
    return {
      headline: ar ? "تم العثور على سعر عام واحد فقط" : "Only one public price found",
      detail: ar
        ? "يلزم سعر عام من الطرفين لإظهار فرق السعر."
        : "A public price from both sides is needed to show a price gap.",
      supporting: "",
      tone: "unavailable",
      lane: "evidence",
    };
  }

  return {
    headline: ar ? "لم يتم العثور على أسعار عامة" : "No public prices found",
    detail: ar
      ? "لم يعرض أي من المنتجين سعراً عاماً يدعم المقارنة في هذا الفحص."
      : "Neither product exposed a public price that can support a comparison in this crawl.",
    supporting: "",
    tone: "unavailable",
    lane: "evidence",
  };
}
