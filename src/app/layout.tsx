import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "雨天走巷子",
  description: "霓虹雨巷撑伞穿行游戏 demo",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
