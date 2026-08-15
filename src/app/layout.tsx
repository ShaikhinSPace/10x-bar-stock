import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk } from "next/font/google";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500", "600"] });
const grotesk = Space_Grotesk({
  variable: "--font-grotesk", subsets: ["latin"], weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "10X Bar Stock",
  description: "Storeroom and bar stock control for 10X Bar.",
};

// viewport-fit=cover so the bottom nav clears the iPhone home indicator.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0D1524",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${grotesk.variable}`}>
      <body>{children}</body>
    </html>
  );
}
