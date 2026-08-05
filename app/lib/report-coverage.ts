export type ReportCoverageEvent = {
  idempotencyKey: string;
  phase: string;
  status: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type ReportCoverageCopy = { label: string; title: string; detail: string };

export function reportCoverage(status: string, events: ReportCoverageEvent[], ar: boolean): ReportCoverageCopy {
  if (status !== "limited") return {
    label: ar ? "جاهز" : "Ready",
    title: ar ? "اكتمل التقرير" : "Report ready",
    detail: ar ? "اكتملت الفحوص العامة المخطط لها لهذا التقرير." : "The planned public-source checks completed for this report.",
  };

  const limited = events.filter((item) =>
    item.status === "limited"
    || item.idempotencyKey.endsWith("-limited")
    || item.metadata?.limited === true
    || /coverage limitation/i.test(item.message),
  );
  const has = (phase: string) => limited.some((item) => item.phase === phase);
  const event = (key: string) => limited.find((item) => item.idempotencyKey === key);
  const crawl = event("crawl-limited");
  const skippedAfterCrawl = limited.some((item) => item.metadata?.upstream === "crawl");
  const persistence = event("facts-limited");
  const matchingStopped = limited.some((item) => item.idempotencyKey === "matching-complete" && item.metadata?.limited === true);
  const matchingUnavailable = event("matching-limited");

  let detail: string;
  if (crawl || skippedAfterCrawl) {
    detail = ar
      ? "لم يكن موقع الشركة العام متاحاً لتحليل السوق، لذلك لم تبدأ فحوص المنافسين والمنتجات والإعلانات. هذه ليست نتيجة صفرية."
      : "The public company website was not available for market analysis, so competitor, product, and ad checks did not run. This is not a zero-result report.";
  } else if (persistence) {
    detail = ar
      ? "تم حفظ التقرير المرئي، لكن تعذر حفظ مجموعة الحقائق المهيكلة الكاملة للتقييم والمتابعة المستقبلية."
      : "The visible report was saved, but the complete structured fact set was not available for future evaluation and tracking.";
  } else if (matchingStopped) {
    detail = ar
      ? "لم يكتمل تقييم بعض المنتجات المختارة ضمن المهلة المحددة. المقارنات الظاهرة موثقة ويمكن استخدامها، لكن قد توجد مطابقات إضافية."
      : "Some selected products were not fully assessed within the bounded run. Visible comparisons are evidence-backed and usable, but additional matches may exist.";
  } else if (matchingUnavailable) {
    detail = ar
      ? "لم يتم العثور على صفحات منتجات أساسية يمكن نسبها إلى الشركة، لذلك لم تبدأ مقارنة المنتجات. هذه ليست دليلاً على عدم وجود منتجات."
      : "No attributable primary product pages were found, so product matching could not run. This is not evidence that the company has no products.";
  } else if (has("enrichment")) {
    detail = ar
      ? "تعذر إعادة قراءة بعض صفحات المنتجات للأسعار أو الصور. بقيت النتائج الموثقة متاحة، وقد تكون بعض التفاصيل ناقصة."
      : "Some product pages could not be re-read for prices or images. Verified results remain usable, while some details may be missing.";
  } else if (has("competitors") || has("brief")) {
    detail = ar
      ? "اكتمل التقرير بالنتائج الموثقة، لكن اكتشاف المنافسين أو ملخص السوق لم يغطِّ كل المصادر المخطط لها."
      : "The report contains verified findings, but competitor discovery or the market brief did not cover every planned source.";
  } else if (has("ads")) {
    detail = ar
      ? "اكتملت أجزاء التقرير الأخرى، لكن فحص سجلات الإعلانات العامة لم يغطِّ كل الشركات أو المنصات المخطط لها."
      : "The other report sections completed, but public ad-record checks did not cover every planned company or platform.";
  } else {
    detail = ar
      ? "اكتملت أجزاء رئيسية من التقرير، لكن السجل القديم لا يحدد الفحص الذي كانت تغطيته جزئية. النتائج الظاهرة فقط هي التي يمكن الاعتماد عليها."
      : "Major report sections completed, but this older record does not identify which check had partial coverage. Only the visible findings should be relied on.";
  }

  return {
    label: ar ? "تغطية جزئية" : "Partial coverage",
    title: ar ? "النتائج جاهزة مع بعض النواقص" : "Results ready, with some gaps",
    detail,
  };
}
