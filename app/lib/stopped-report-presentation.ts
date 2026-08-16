export type StoppedReportPresentation = {
  title: string;
  summary: string;
};

export function stoppedReportPresentation(errorMessage: string | null | undefined, errorCode: string | null | undefined, ar: boolean): StoppedReportPresentation {
  const message = errorMessage?.trim() || "";
  const code = errorCode?.trim().toLowerCase() || "";
  const refusedHomepage = /(?:homepage|primary domain).*http 403|http 403.*(?:homepage|primary domain)/i.test(message)
    || (code.includes("primary") && code.includes("403"));

  if (refusedHomepage) return ar ? {
    title: "منع الموقع فحص التقرير",
    summary: "أعاد الموقع HTTP 403 عند طلب صفحته الرئيسية العامة، لذلك لم تُنشأ مقارنة السوق. هذا قيد وصول، وليس دليلاً على أن الموقع أو النشاط غير متاح.",
  } : {
    title: "The website blocked the report check",
    summary: "The website returned HTTP 403 when Market Signal requested its public homepage, so no market comparison was created. This is an access restriction, not proof that the website or business is unavailable.",
  };

  return ar ? {
    title: "توقف التقرير قبل إنشاء المقارنة",
    summary: message || "لم يكتمل هذا التشغيل، لذلك لم تُنشر مقارنة للسوق.",
  } : {
    title: "The report stopped before comparison",
    summary: message || "This run did not complete, so no market comparison was published.",
  };
}
