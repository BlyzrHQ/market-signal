import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "@fontsource-variable/archivo";
import "@fontsource/abril-fatface/400.css";
import "./globals.css";

const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Market Signal — Know where your market is moving",
  description: "Evidence-backed competitive intelligence for startups, agencies, and ecommerce brands.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body className={geistMono.variable}>{children}</body></html>;
}
