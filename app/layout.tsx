import type { Metadata } from "next";
import "./styles.css";

export const metadata: Metadata = {
  title: "Compute Storefront",
  description: "Rent a temporary bare Linux machine.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

