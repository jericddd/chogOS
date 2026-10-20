import type { Metadata } from "next";
import { Press_Start_2P, Silkscreen } from "next/font/google";
import { AppShell } from "@/components/shell/app-shell";
import "./globals.css";

const pressStart = Press_Start_2P({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-press",
  display: "swap",
});

const silkscreen = Silkscreen({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-silk",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "chogOS",
    template: "%s · chogOS",
  },
  description:
    "One shared, persistent civilization for Chog Genesis NFT participants on Monad. The world runs on the server. An AI mind can act; visitors inspect and verify.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${pressStart.variable} ${silkscreen.variable} h-full`}
    >
      <body className="min-h-full">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
