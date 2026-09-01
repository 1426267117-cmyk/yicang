import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: '易仓 ERP｜跨境业务管理平台',
  description: '统一管理订单、库存、采购、仓库、物流与财务的跨境电商 ERP。',
  openGraph: {
    title: '易仓 ERP｜跨境业务管理平台',
    description: '订单、库存、采购、仓储与财务一体化。',
    type: 'website',
    images: [{ url: '/og.png', width: 1734, height: 907, alt: '易仓 ERP 跨境业务管理平台' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: '易仓 ERP｜跨境业务管理平台',
    description: '订单、库存、采购、仓储与财务一体化。',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
