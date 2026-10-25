import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Porto — your reading, in order",
  description: "A quiet place to catch up on the feeds you follow.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
