import type { Metadata } from "next";
import { Suspense } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import AuthRedirectGate from "@/components/AuthRedirectGate";
import { AuthProvider } from "@/context/AuthContext";
import { ProfileProvider } from "@/context/ProfileContext";
import { CatalogProvider } from "@/context/CatalogContext";
import { FavoritesProvider } from "@/context/FavoritesContext";
import { CartProvider } from "@/context/CartContext";
import { AnalyticsProvider } from "@/context/AnalyticsContext";
import { AnalyticsConsentBanner } from "@/components/AnalyticsConsentBanner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "DEKORO B2B",
  description:
    "B2B-платформа для продажи строительных материалов DEKORO",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-white text-neutral-800">
        <AuthProvider>
          <ProfileProvider>
            <CatalogProvider>
              <FavoritesProvider>
                <CartProvider>
                  <Suspense fallback={null}>
                    <AuthRedirectGate />
                    <AnalyticsProvider>
                      <Header />
                      <main className="flex-1">{children}</main>
                      <Footer />
                      <AnalyticsConsentBanner />
                    </AnalyticsProvider>
                  </Suspense>
                </CartProvider>
              </FavoritesProvider>
            </CatalogProvider>
          </ProfileProvider>
        </AuthProvider>
      </body>
    </html>
  );
}
