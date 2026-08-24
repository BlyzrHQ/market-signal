"use client";

import { StoredReportClient } from "../../reports/[publicId]/page";

export default function SharedReportPage({ params }: { params: Promise<{ token: string }> | { token: string } }) {
  return <StoredReportClient params={params} mode="shared" />;
}
