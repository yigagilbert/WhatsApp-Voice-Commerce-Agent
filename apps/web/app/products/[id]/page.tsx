import Link from 'next/link';
import { ErrorNotice, PageHeader, Section } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { money } from '@/lib/format';
import type { Product } from '@/lib/types';
import { ProductDetailsForm, ProductPhotoForm } from './product-form';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [products, photo] = await Promise.all([
    apiGet<Product[]>('/api/products'),
    apiGet<unknown>(`/api/products/${encodeURIComponent(id)}/image`),
  ]);
  if (!products.ok) return <ErrorNotice message={products.error} />;
  const product = products.data.find((p) => p.id === id);
  if (!product) return <ErrorNotice message="Product not found." />;
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/products" className="text-slate-500 hover:underline">
          ← Products
        </Link>
      </p>
      <PageHeader
        title={product.name}
        description={`${money(product.unitPriceMinor, product.currency)} · ${
          product.stockQuantity == null ? 'stock not tracked' : `${product.stockQuantity} in stock`
        }${product.active ? '' : ' · inactive'}. Customers only see In stock / Low stock / Out of stock.`}
      />
      <div className="grid max-w-4xl gap-6 md:grid-cols-2">
        <Section title="Photo">
          <ProductPhotoForm id={product.id} hasPhoto={photo.ok} />
        </Section>
        <Section title="For customers">
          <ProductDetailsForm
            id={product.id}
            description={product.description}
            visibleToCustomers={product.visibleToCustomers ?? true}
          />
        </Section>
      </div>
    </>
  );
}
