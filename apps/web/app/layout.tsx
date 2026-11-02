import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Geist } from 'next/font/google';
import type { ReactNode } from 'react';
import { siteUrl } from '@/lib/public-site';
import './globals.css';

// Self-hosted at build time by next/font: no requests to Google from visitors' browsers.
const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-bricolage',
  display: 'swap',
});

const description =
  'Run your shop from WhatsApp: orders by voice or text, PayPal payment links, stock alerts and sales reports. The AI prepares; you approve; PayPal executes.';

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: new URL(await siteUrl()),
    title: { default: 'Katale AI — Run your shop from WhatsApp', template: '%s · Katale AI' },
    description,
    applicationName: 'Katale AI',
    openGraph: {
      type: 'website',
      siteName: 'Katale AI',
      title: 'Katale AI — Run your shop from WhatsApp',
      description,
    },
    twitter: { card: 'summary_large_image' },
  };
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafbf7' },
    { media: '(prefers-color-scheme: dark)', color: '#121a16' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${bricolage.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
