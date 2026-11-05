import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Figtree, Geist_Mono } from 'next/font/google'
import { CartProvider } from '@/components/cart-provider'
import { FirebaseAuthProvider } from '@/components/firebase-auth'
import { SiteHeader } from '@/components/site-header'
import { SiteFooter } from '@/components/site-footer'
import './globals.css'

const _figtree = Figtree({ subsets: ['latin'] })
const _geistMono = Geist_Mono({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Vitrine | Compre online com cartão e Pix',
  description:
    'Loja online com eletrônicos, casa e esportes. Pague com cartão de crédito em até 10x sem juros ou com Pix com desconto.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  themeColor: '#f5c518',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="pt-BR" className="bg-background">
      <body className="flex min-h-dvh flex-col antialiased">
        <FirebaseAuthProvider>
          <CartProvider>
            <SiteHeader />
            <div className="flex-1">{children}</div>
            <SiteFooter />
          </CartProvider>
        </FirebaseAuthProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
