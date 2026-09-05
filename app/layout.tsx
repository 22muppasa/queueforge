import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'https://queueforge-distributed-jobs.civil-ghost-1928.chatgpt.site'),
  title: 'QueueForge — Distributed job control plane',
  description: 'Monitor jobs, workers, retries, leases, and dead letters across QueueForge.',
  openGraph: {
    title: 'QueueForge — Distributed jobs. Durable recovery.',
    description: 'A PostgreSQL-backed job system with leases, retries, idempotency, crash recovery, and a live operations dashboard.',
    type: 'website',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'QueueForge distributed jobs and durable recovery' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QueueForge — Distributed jobs. Durable recovery.',
    description: 'A PostgreSQL-backed job system with leases, retries, idempotency, crash recovery, and a live operations dashboard.',
    images: ['/og.png'],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" className="dark"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
