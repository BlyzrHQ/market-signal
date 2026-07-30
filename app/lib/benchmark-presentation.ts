export type BenchmarkPosition = {
  key: string;
  yours: number | null;
  median: number | null;
  leader: number | null;
};

export type BenchmarkPositionWithDelta = BenchmarkPosition & {
  delta: number | null;
  band: "behind" | "level" | "ahead" | "unknown";
};

export function orderBenchmarkPositions<T extends BenchmarkPosition>(positions: T[]): Array<T & BenchmarkPositionWithDelta> {
  return positions
    .map((position) => {
      const delta = position.yours === null || position.median === null ? null : position.yours - position.median;
      const band = delta === null ? "unknown" : delta < 0 ? "behind" : delta > 0 ? "ahead" : "level";
      return { ...position, delta, band } as T & BenchmarkPositionWithDelta;
    })
    .sort((left, right) => {
      const priority = { behind: 0, level: 1, ahead: 2, unknown: 3 };
      const priorityDifference = priority[left.band] - priority[right.band];
      if (priorityDifference) return priorityDifference;
      if (left.band === "behind") return (left.delta ?? 0) - (right.delta ?? 0);
      if (left.band === "ahead") return (right.delta ?? 0) - (left.delta ?? 0);
      return left.key.localeCompare(right.key);
    });
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return value !== null && value !== "" && Number.isFinite(parsed) ? parsed : null;
}

export function benchmarkGapAction(key: string, observed: Record<string, unknown>, ar: boolean) {
  if (key === "images") {
    const products = numberOrNull(observed.products);
    const withImage = numberOrNull(observed.productsWithImage);
    if (products !== null && withImage !== null && products > withImage) return ar ? `أضف صوراً إلى ${products - withImage} منتجاً عاماً دون صورة.` : `Add images to ${products - withImage} public products currently missing one.`;
    const alt = numberOrNull(observed.altCoverage);
    if (alt !== null && alt < 100) return ar ? "حسّن النص البديل المفيد للصور العامة المرصودة." : "Improve meaningful alt text on the observed public images.";
    return ar ? "حسّن ترميز الصور المتجاوبة المرصود على الصفحات العامة." : "Improve the responsive image markup observed on public pages.";
  }
  if (key === "information") {
    const completed = numberOrNull(observed.completedFields);
    const possible = numberOrNull(observed.possibleFields);
    if (completed !== null && possible !== null) return ar ? `أكمل ${Math.max(0, possible - completed)} حقلاً عاماً مفقوداً في عينة المنتجات.` : `Complete ${Math.max(0, possible - completed)} missing public fields in the product sample.`;
  }
  if (key === "productAccess") return ar ? "أظهر روابط المنتجات أو الفئات بشكل مباشر أكثر من الصفحة الرئيسية." : "Surface product or catalog links more directly from the homepage.";
  if (key === "purchasePath") {
    if (!observed.hasProductPath) return ar ? "أظهر مساراً عاماً مباشراً إلى صفحات المنتجات." : "Expose a direct public path to product pages.";
    if (!observed.hasAddToCart) return ar ? "أظهر عنصر إضافة إلى السلة على صفحات المنتجات العامة." : "Expose an add-to-cart control on public product pages.";
    if (!observed.hasCartLink) return ar ? "أظهر رابط السلة بوضوح في المسار العام." : "Expose a clear cart link in the public path.";
    if (!observed.hasCheckoutLink) return ar ? "أظهر الانتقال العام من السلة إلى الدفع بوضوح." : "Expose the public cart-to-checkout transition clearly.";
  }
  if (key === "trust") {
    const missing = [
      ["shipping", ar ? "الشحن" : "shipping"],
      ["returns", ar ? "الإرجاع" : "returns"],
      ["contact", ar ? "التواصل" : "contact"],
      ["legal", ar ? "السياسات" : "policies"],
      ["company", ar ? "معلومات الشركة" : "company information"],
    ].filter(([field]) => !observed[field]).map(([, label]) => label);
    if (missing.length) return ar ? `أظهر أدلة عامة أوضح حول: ${missing.join("، ")}.` : `Expose clearer public evidence for ${missing.join(", ")}.`;
  }
  if (key === "mobileAccessibility") {
    if (!observed.viewport) return ar ? "أضف إعداد عرض متجاوباً للصفحات العامة." : "Add responsive viewport metadata to public pages.";
    if (!observed.documentLanguage) return ar ? "عرّف لغة المستند على الصفحات العامة." : "Declare the document language on public pages.";
    return ar ? "حسّن النص البديل المفيد للصور العامة المرصودة." : "Improve meaningful alt text on the observed public images.";
  }
  return ar ? "راجع الدليل العام المرصود لهذا المقياس." : "Review the observed public evidence for this metric.";
}
