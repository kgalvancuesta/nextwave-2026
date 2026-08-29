import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_BASE_URL || "http://localhost:3000"),
  title: "Marketline | Telephony Control",
  description: "Carrier phonebook and live PSTN call control for Marketline.",
  openGraph: {
    title: "Marketline",
    description: "Carrier market telephony control",
    images: [{ url: "/og.png", width: 1672, height: 941, alt: "Marketline carrier market telephony control" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Marketline",
    description: "Carrier market telephony control",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
