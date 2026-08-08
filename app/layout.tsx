import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const siteUrl = `${protocol}://${host}`;

  return {
    metadataBase: new URL(siteUrl),
    title: "Verdue — Verified claim discovery & tracking",
    description:
      "Explore verified class-action settlement claim windows, prepare reusable details, and track what happens after you file.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "Verdue — Find claims. Track what happens next.",
      description:
        "Verified settlement sources, clear deadlines, and an honest personal claim ledger.",
      type: "website",
      url: siteUrl,
      images: [{ url: `${siteUrl}/og.png`, width: 1200, height: 630, alt: "Verdue — Find claims. Track what happens next." }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Verdue — Find claims. Track what happens next.",
      description:
        "Verified settlement sources, clear deadlines, and an honest personal claim ledger.",
      images: [`${siteUrl}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
