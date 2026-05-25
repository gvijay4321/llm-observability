import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import AppSidebar from '@/components/AppSidebar';
import { SidebarProvider } from '@/components/SidebarContext';
import './globals.css';

export const metadata: Metadata = {
  title: 'LLM Observability - Chatbot',
  description: 'Chatbot with inference logging, ingestion pipeline and live dashboards',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <SidebarProvider>
          <div className="page">
            <AppSidebar />
            <div className="page-stage">{children}</div>
          </div>
        </SidebarProvider>
      </body>
    </html>
  );
}
