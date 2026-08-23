export function workerOnlyResponse(role = process.env.MARKET_SIGNAL_PROCESS_ROLE) {
  if (role !== "app") return null;
  return Response.json(
    { ok: false, error: "Report processing is unavailable on the customer application process." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
