'use client';

import { useState } from 'react';
import { MAX_LINE_QUANTITY } from '@/lib/storefront-types';
import { useCart } from './cart-context';
import { Stepper } from './cart-drawer';
import s from '../shop.module.css';

/** Quantity and add-to-cart on a product page. */
export function BuyPanel({
  productId,
  name,
  disabled,
  disabledLabel,
}: {
  productId: string;
  name: string;
  disabled: boolean;
  disabledLabel?: string;
}) {
  const { add, items } = useCart();
  const [quantity, setQuantity] = useState(1);
  const inCart = items.find((i) => i.productId === productId)?.quantity ?? 0;
  if (disabled)
    return (
      <button type="button" className={s.primary} disabled>
        {disabledLabel}
      </button>
    );
  return (
    <div className={s.buy}>
      <Stepper
        label="Quantity"
        value={quantity}
        min={1}
        max={MAX_LINE_QUANTITY}
        onChange={setQuantity}
      />
      <button
        type="button"
        className={s.primary}
        onClick={() => {
          add(productId, quantity, name);
          setQuantity(1);
        }}
      >
        Add to cart
      </button>
      {inCart > 0 && <p className={s.inCartNote}>{inCart} in your cart</p>}
    </div>
  );
}
