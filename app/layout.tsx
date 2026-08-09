import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ProductAnalyticsProvider } from "./components/product-analytics-provider";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Market Signal — Know where your market is moving",
  description: "Evidence-backed competitive intelligence for startups, agencies, and ecommerce brands.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={`${geistSans.variable} ${geistMono.variable}`}><ProductAnalyticsProvider />{children}</body></html>;
}
