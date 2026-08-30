import type { Metadata } from "next";
import "./globals.css";
import { DM_Sans, Martian_Mono } from "next/font/google";
import { cn } from "@/lib/utils";

const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-sans" });
const martianMono = Martian_Mono({ subsets: ["latin"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_BASE_URL || "http://localhost:3000"),
  title: "Marketline | Order + Market State",
  description: "Authoritative order, carrier market, offer, commitment, and live-call operations for ground transport procurement.",
  openGraph: {
    title: "Marketline",
    description: "Order, market, offer, commitment, and live-call operations",
    images: [{ url: "/og.png", width: 1672, height: 941, alt: "Marketline carrier market telephony control" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Marketline",
    description: "Order, market, offer, commitment, and live-call operations",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("font-sans", dmSans.variable, martianMono.variable)}>
      <body>{children}</body>
    </html>
  );
}
