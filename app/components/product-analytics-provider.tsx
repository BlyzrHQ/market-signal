"use client";

import { useEffect } from "react";
import { initializeProductAnalytics } from "../lib/product-analytics-client";

export function ProductAnalyticsProvider() {
  useEffect(() => { initializeProductAnalytics(); }, []);
  return null;
}
