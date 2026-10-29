import Link from 'next/link';
import { PageHeader } from '@/components/ui';
import { apiGet } from '@/lib/api';
import { ProductEditor } from '../product-editor';

export const dynamic = 'force-dynamic';

export default async function NewProductPage() {
  // New products are priced in the business's currency.
  const me = await apiGet<{ merchant: { currency: string } }>('/api/auth/me');
  const currency = me.ok ? me.data.merchant.currency : 'USD';
  return (
    <>
      <p className="mb-2 text-sm">
        <Link href="/products" className="text-slate-500 hover:underline">
          ← Products
        </Link>
      </p>
      <PageHeader
        title="Add a product"
        description="Name, price and a photo are enough to start selling. Customers see it on WhatsApp right away."
      />
      <div className="max-w-3xl">
        <ProductEditor currency={currency} />
      </div>
    </>
  );
}
