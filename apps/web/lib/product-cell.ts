/** What an edited Products grid cell saves, or why it can't be saved. */
export type CellChange =
  | { category: string }
  | { shown: boolean }
  | { price: string }
  | { stock: number }
  | { problem: string };

const isBlank = (value: unknown) => value == null || String(value).trim() === '';

export function cellChange(field: string | undefined, value: unknown): CellChange {
  if (field === 'category') return { category: String(value ?? '') };
  if (field === 'shownLabel') return { shown: value === 'Shown' };
  const number = Number(value);
  if (field === 'price') {
    if (isBlank(value) || !Number.isFinite(number) || number <= 0)
      return { problem: 'enter a price such as 12 or 12.50. The price was not changed.' };
    return { price: number.toFixed(2) };
  }
  // Clearing a stock cell must not count as "we have none": 0 hides the product from sale.
  if (isBlank(value) || !Number.isInteger(number) || number < 0)
    return { problem: 'enter a whole number, or 0 if you have none. The stock was not changed.' };
  return { stock: number };
}
