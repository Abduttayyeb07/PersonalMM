import type { Metadata } from "next";
import { connection } from "next/server";
import { DM_Mono, DM_Sans, Manrope } from "next/font/google";
import "./globals.css";

// Self-hosted at build time by next/font, so the strict CSP (font-src self) is unaffected.
const manrope = Manrope({ subsets: ["latin"], weight: ["500", "600", "700", "800"], variable: "--font-manrope" });
const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-dm-sans" });
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-dm-mono" });

export const metadata: Metadata = {
  title: "ZIG Grid Engine",
  description: "Sell-first grid engine for ZIG/USDT",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Render per request so the CSP nonce from proxy.ts is applied to framework scripts.
  await connection();
  return (
    <html lang="en" className={`h-full antialiased ${manrope.variable} ${dmSans.variable} ${dmMono.variable}`}>
      <body className="min-h-full" suppressHydrationWarning>{children}</body>
    </html>
  );
}
