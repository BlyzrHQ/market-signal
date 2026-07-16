"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Block = { type: string; id: string } & Record<string, unknown>;
type StoredPayload = { ok: boolean; error?: string; report?: { run: { primaryDomain: string; locale: "en" | "ar"; status: string; createdAt: string; updatedAt: string; errorMessage: string }; document: { document?: { version: "1"; generatedAt: string; blocks: Block[] }; marketBrief?: Record<string, unknown> } | null; documentSchemaVersion: number } };

function object(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function list(value: unknown) { return Array.isArray(value) ? value : []; }

function ReportSnapshot({ blocks, ar }: { blocks: Block[]; ar: boolean }) {
  const competitors = blocks.filter((block) => block.type === "competitor");
  const comparison = blocks.find((block) => block.type === "product-comparison");
  const rows = list(comparison?.rows);
  const battles = rows.flatMap((row) => {
    const item = object(row); const primary = object(item.primary);
    return list(item.matches).flatMap((match) => { const candidate = object(match); const rival = object(candidate.product); return rival.name ? [{ primary, rival, match: candidate }] : []; });
  }).slice(0, 12);
  const adBlock = blocks.find((block) => block.type === "ad-intelligence");
  const adCompanies = list(adBlock?.companies);
  return <div className="stored-snapshot-grid">
    <section className="snapshot-section snapshot-rivals"><header><span>01</span><div><p>{ar ? "المنافسون" : "COMPETITORS"}</p><h2>{ar ? "من يتنافس معك الآن؟" : "Who is competing for the same customer?"}</h2></div><b>{competitors.length}</b></header><div className="snapshot-card-grid">{competitors.map((block) => <article key={block.id}><span>{String(block.confidence || "")}</span><h3>{String(block.companyName || block.domain || "Competitor")}</h3><p>{String(block.reason || block.description || "Verified public category overlap.")}</p><a href={String(block.websiteSourceUrl || block.discoverySourceUrl || "#")} target="_blank" rel="noreferrer">{ar ? "المصدر ↗" : "Source ↗"}</a></article>)}</div></section>
    <section className="snapshot-section snapshot-products"><header><span>02</span><div><p>{ar ? "مقارنة المنتجات" : "PRODUCT BATTLES"}</p><h2>{ar ? "أقرب المنتجات المنافسة" : "The closest products rivals put against yours"}</h2></div><b>{battles.length}</b></header><div className="snapshot-battles">{battles.map((battle, index) => <article key={`${String(battle.primary.id)}-${String(battle.rival.id)}-${index}`}><div><span>{ar ? "منتجك" : "YOUR PRODUCT"}</span><h3>{String(battle.primary.name || "Observed product")}</h3><a href={String(battle.primary.sourceUrl || "#")} target="_blank" rel="noreferrer">{ar ? "المصدر" : "Source"}</a></div><i>↔</i><div><span>{ar ? "المنافس" : "RIVAL PRODUCT"}</span><h3>{String(battle.rival.name || "Observed rival product")}</h3><a href={String(battle.rival.sourceUrl || "#")} target="_blank" rel="noreferrer">{ar ? "المصدر" : "Source"}</a></div></article>)}</div></section>
    <section className="snapshot-section snapshot-ads"><header><span>03</span><div><p>{ar ? "نشاط الإعلانات" : "AD ACTIVITY"}</p><h2>{ar ? "ما الذي استطعنا التحقق منه؟" : "What could be verified publicly?"}</h2></div><b>{adCompanies.length}</b></header>{adCompanies.length ? <div className="snapshot-card-grid">{adCompanies.map((company, index) => { const item = object(company); return <article key={`${String(item.domain)}-${index}`}><h3>{String(item.brand || item.domain || "Advertiser")}</h3><p>{ar ? "تغطية مكتبات الإعلانات محفوظة مع التقرير." : "Ad-library coverage is saved with this report."}</p></article>; })}</div> : <p className="snapshot-empty">{ar ? "لم تُحفظ نتيجة إعلانات متحققة لهذا التشغيل." : "No verified ad result was saved for this run."}</p>}</section>
  </div>;
}

export default function StoredReportPage({ params }: { params: Promise<{ publicId: string }> | { publicId: string } }) {
  const [payload, setPayload] = useState<StoredPayload | null>(null); const [error, setError] = useState("");
  useEffect(() => { let current = true; Promise.resolve(params).then(({ publicId }) => fetch(`/api/reports/${publicId}`, { cache: "no-store" })).then(async (response) => ({ response, body: await response.json() as StoredPayload })).then(({ response, body }) => { if (!current) return; if (!response.ok || !body.ok) setError(body.error || "The saved report could not be opened."); else { setPayload(body); if (!body.report?.document && ["queued", "running"].includes(body.report?.run.status || "")) Promise.resolve(params).then(({ publicId }) => window.location.replace(`/reports/${publicId}/loading`)); } }).catch(() => current && setError("The saved report could not be opened.")); return () => { current = false; }; }, [params]);
  const report = payload?.report; const stored = report?.document; const document = stored?.document; const ar = report?.run.locale === "ar"; const dir = ar ? "rtl" : "ltr";
  if (error) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "التقرير غير متاح" : "Report unavailable"}</h1><p>{error}</p></main>;
  if (report && !document && ["failed", "interrupted"].includes(report.run.status)) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "توقف هذا التقرير" : "This report stopped"}</h1><p>{report.run.errorMessage || (ar ? "ابدأ تقريراً جديداً للمحاولة مرة أخرى." : "Start a fresh report to try again.")}</p></main>;
  if (!report || !document) return <main className="stored-report-state"><div className="route-spinner" /><p>Opening the saved market report…</p></main>;
  if (report.documentSchemaVersion !== 1) return <main className="stored-report-state" lang={ar ? "ar" : "en"} dir={dir}><Link href="/">Market Signal</Link><h1>{ar ? "نسخة التقرير غير مدعومة" : "Unsupported report version"}</h1></main>;
  return <main className="stored-report-page" lang={ar ? "ar" : "en"} dir={dir}><header className="report-route-header"><Link href="/">Market Signal</Link><div><span>{report.run.status.toUpperCase()}</span><b>{report.run.primaryDomain}</b></div><Link href="/">{ar ? "تقرير جديد" : "New report"}</Link></header><section className="stored-report-hero"><p>{ar ? "معلومات تنافسية / تقرير محفوظ" : "COMPETITIVE INTELLIGENCE / SAVED REPORT"}</p><h1>{ar ? `${report.run.primaryDomain} في مواجهة السوق.` : `${report.run.primaryDomain} against the market.`}</h1><span>{ar ? "آخر تحديث" : "Observed"} {new Date(report.run.updatedAt).toLocaleString(ar ? "ar" : "en")}</span></section><ReportSnapshot blocks={document.blocks} ar={ar} /></main>;
}

