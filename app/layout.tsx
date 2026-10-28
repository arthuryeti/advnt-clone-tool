import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type * as React from "react";
import { Providers } from "@/components/providers";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: { default: "Video Clone", template: "%s | Video Clone" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      className={`dark ${inter.variable} ${jetbrainsMono.variable}`}
      lang="en"
    >
      <body className="min-h-screen bg-[#09090B] font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
