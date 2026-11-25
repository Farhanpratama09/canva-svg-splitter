import type { Metadata, Viewport } from "next";
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

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : undefined);

const appTitle = "Canva SVG Splitter — Pemecah Layer Vektor Ilustrasi 2D";
const appDescription =
  "Ubah ilustrasi 2D datar (PNG/JPG/WEBP) dan SVG menjadi layer vektor kompatibel color picker Canva Free, lengkap dengan Batch & Ekspor HD, 100% diproses di browser.";

export const metadata: Metadata = {
  ...(siteUrl ? { metadataBase: new URL(siteUrl) } : {}),
  title: appTitle,
  description: appDescription,
  applicationName: "Canva SVG Splitter",
  keywords: [
    "Canva SVG Splitter",
    "Canva Free",
    "SVG Vectorizer",
    "Pemecah Warna SVG",
    "Stiker Die-Cut",
    "Keyring Merchandise",
  ],
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "SVG Splitter",
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    title: appTitle,
    description: appDescription,
    type: "website",
    locale: "id_ID",
    siteName: "Canva SVG Splitter",
    images: [
      {
        url: "/icon-512.png",
        width: 512,
        height: 512,
        alt: "Logo Canva SVG Splitter",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: appTitle,
    description: appDescription,
    images: ["/icon-512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#09090b",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="id"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[#0F1115] font-sans text-slate-100">
        {children}
      </body>
    </html>
  );
}
