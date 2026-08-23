import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import Providers from "@/components/Providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Nexus Price",
  description: "Historical and current ERC-20 token prices with interpolation and caching.",
};

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
        {/* SessionProvider (Providers) and Toaster live here, in the single
            root layout, so every route - landing, dashboard, auth - gets the
            session context and toast host exactly once. They used to sit in
            the (app) route-group layout, which also rendered its own
            <html>/<body>, producing nested <html> tags (invalid markup +
            hydration errors) on every page under (app). */}
        <Providers>
          <Toaster />
          {children}
        </Providers>
      </body>
    </html>
  );
}
