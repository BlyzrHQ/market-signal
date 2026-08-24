"use client";

import { useEffect, useState } from "react";
import { jsonResponseErrorMessage, readJsonResponse } from "../lib/json-response";

type SharePayload = {
  ok: boolean;
  error?: string;
  shared?: boolean;
  publicUrl?: string;
  sharedAt?: string;
};

async function copyText(value: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch { /* Use the selection fallback. */ }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { input.remove(); }
}

type ReportShareControlProps = { publicId: string; ar: boolean };

export function ReportShareControl(props: ReportShareControlProps) {
  return <ReportShareControlState key={props.publicId} {...props} />;
}

function ReportShareControlState({ publicId, ar }: ReportShareControlProps) {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [message, setMessage] = useState("");
  const [fallback, setFallback] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/reports/${publicId}/sharing`, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal: controller.signal })
      .then(async (response) => ({ response, body: await readJsonResponse<SharePayload>(response, "Report sharing") }))
      .then(({ response, body }) => {
        if (!response.ok || !body.ok) { setAvailable(false); return; }
        setAvailable(true); setShared(body.shared === true); setPublicUrl(body.publicUrl || "");
      })
      .catch((cause) => { if (!controller.signal.aborted) setMessage(jsonResponseErrorMessage(cause, "Report sharing is unavailable.")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [publicId]);

  const mutate = async (action: "share" | "unshare") => {
    setBusy(true); setMessage(""); setFallback("");
    try {
      const response = await fetch(`/api/reports/${publicId}/sharing`, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = await readJsonResponse<SharePayload>(response, "Report sharing");
      if (!response.ok || !body.ok) throw new Error(body.error || "The report sharing state could not be changed.");
      setShared(body.shared === true); setPublicUrl(body.publicUrl || "");
      setMessage(action === "share" ? (ar ? "تم إنشاء رابط عام جديد." : "A new public link is ready.") : (ar ? "أصبح التقرير خاصاً وتم إلغاء الرابط العام." : "The report is private and the public link is revoked."));
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "The report sharing state could not be changed."); }
    finally { setBusy(false); }
  };

  const copyPublicLink = async () => {
    setMessage(""); setFallback("");
    if (!publicUrl) return;
    if (await copyText(publicUrl)) setMessage(ar ? "تم نسخ الرابط العام." : "Public link copied.");
    else { setMessage(ar ? "انسخ الرابط العام أدناه." : "Copy the public link below."); setFallback(publicUrl); }
  };

  const revoke = () => {
    if (!window.confirm(ar ? "إلغاء الرابط العام وجعل التقرير خاصاً؟ لن يعمل الرابط القديم بعد ذلك." : "Make this report private? The current public link will stop working.")) return;
    void mutate("unshare");
  };

  if (loading) return <div className="report-share-control loading" aria-label={ar ? "جارٍ تحميل حالة المشاركة" : "Loading sharing status"}><span>{ar ? "خاص" : "Private"}</span></div>;
  if (!available) return null;
  return <div className={`report-share-control ${shared ? "shared" : "private"}`}>
    <span>{shared ? (ar ? "تقرير مشترك" : "Shared report") : (ar ? "تقرير خاص" : "Private report")}</span>
    {shared
      ? <><button type="button" disabled={busy} onClick={() => void copyPublicLink()}>{ar ? "نسخ الرابط العام" : "Copy public link"}</button><button type="button" className="report-unshare-button" disabled={busy} onClick={revoke}>{ar ? "جعله خاصاً" : "Make private"}</button></>
      : <button type="button" disabled={busy} onClick={() => void mutate("share")}>{busy ? (ar ? "جارٍ الإنشاء…" : "Creating…") : (ar ? "مشاركة التقرير" : "Share report")}</button>}
    {(message || fallback) && <div className="report-share-feedback" role="status" aria-live="polite"><small>{message}</small>{fallback && <input value={fallback} readOnly onFocus={(event) => event.currentTarget.select()} aria-label={ar ? "رابط التقرير العام" : "Public report link"} />}</div>}
  </div>;
}
