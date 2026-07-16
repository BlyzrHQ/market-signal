"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Event = { sequence: number; idempotencyKey: string; message: string };
type Run = { status: string; primaryDomain: string; errorMessage: string; locale: "en" | "ar" };

function eventMessage(event: Event | undefined, ar: boolean) {
  if (!event || !ar) return event?.message || (ar ? "جارٍ فتح تشغيل التقرير المحفوظ." : "Opening the saved report run.");
  const messages: Record<string, string> = { "run-created": "تم إنشاء التقرير وبدأ جمع المصادر العامة.", "crawl-started": "نفحص موقعك وصفحات المنتجات العامة.", "crawl-complete": "اكتمل جمع الكتالوج والتحقق من المنافسين.", "ads-started": "نفحص سجلات المعلنين العامة.", "ads-complete": "اكتمل فحص مكتبات الإعلانات.", "matching-started": "نقارن أقوى عائلات المنتجات.", "matching-complete": "اكتملت مطابقة المنتجات وربط المصادر.", "report-saved": "تم حفظ التقرير." };
  return messages[event.idempotencyKey] || event.message;
}

export default function PersistedLoadingPage({ params }: { params: Promise<{ publicId: string }> | { publicId: string } }) {
  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    let timer = 0;
    Promise.resolve(params).then(({ publicId }) => {
      const poll = async () => {
        try {
          const response = await fetch(`/api/reports/${publicId}`, { cache: "no-store" });
          const body = await response.json();
          if (!current) return;
          if (!response.ok || !body.ok) throw new Error(body.error || "The report run could not be opened.");
          setRun(body.report.run);
          setEvents(body.report.events || []);
          if (["complete", "limited"].includes(body.report.run.status) && body.report.document) window.location.replace(`/reports/${publicId}`);
          else if (!["failed", "interrupted"].includes(body.report.run.status)) timer = window.setTimeout(poll, 1800);
        } catch (cause) { if (current) setError(cause instanceof Error ? cause.message : "The report run could not be opened."); }
      };
      void poll();
    });
    return () => { current = false; window.clearTimeout(timer); };
  }, [params]);

  const ar = run?.locale === "ar";
  const latest = eventMessage(events.at(-1), ar);
  const stopped = run && ["failed", "interrupted"].includes(run.status);
  return (
    <main className="analysis-loading-page" lang={ar ? "ar" : "en"} dir={ar ? "rtl" : "ltr"}>
      <Link className="loading-brand" href="/">Market Signal <span>LIVE RUN</span></Link>
      <section className="loading-stage" aria-live="polite">
        <div className={`market-radar ${stopped ? "radar-stopped" : ""}`} aria-hidden="true"><i /><i /><i /><b /></div>
        <p className="loading-kicker">{stopped ? (ar ? "التقرير يحتاج إلى انتباه" : "RUN NEEDS ATTENTION") : (ar ? "نبني خريطة السوق" : "BUILDING YOUR MARKET MAP")}</p>
        <h1>{run?.primaryDomain || "Opening your report"}</h1>
        <p className="loading-status">{error || run?.errorMessage || latest}</p>
        <div className="loading-event-list">{events.slice(-4).map((event) => <span key={event.sequence}>{eventMessage(event, ar)}</span>)}</div>
        {stopped && <Link className="loading-restart" href="/">{ar ? "ابدأ تقريراً جديداً" : "Start a fresh report"}</Link>}
      </section>
    </main>
  );
}
