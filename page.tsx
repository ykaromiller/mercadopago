import Link from 'next/link'
import { HeroBanner } from '@/components/hero-banner'
import { ProductGrid } from '@/components/product-grid'
import { categories, getProducts } from '@/lib/products'

export default function HomePage() {
  const products = getProducts()
  const deals = products.filter((product) => product.originalPriceCents)

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-4 py-6">
      <HeroBanner />

      <section aria-labelledby="ofertas" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="ofertas" className="text-2xl font-semibold">
            Ofertas do dia
          </h2>
          <Link href="/busca" className="text-sm font-medium text-secondary hover:underline">
            Ver todas
          </Link>
        </div>
        <ProductGrid products={deals} />
      </section>

      {categories.map((category) => {
        const items = getProducts({ category: category.slug })
        if (items.length === 0) return null
        return (
          <section key={category.slug} aria-labelledby={`cat-${category.slug}`} className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4">
              <h2 id={`cat-${category.slug}`} className="text-2xl font-semibold">
                {category.name}
              </h2>
              <Link
                href={`/busca?categoria=${category.slug}`}
                className="text-sm font-medium text-secondary hover:underline"
              >
                Ver mais
              </Link>
            </div>
            <ProductGrid products={items} />
          </section>
        )
      })}
    </main>
  )
}
