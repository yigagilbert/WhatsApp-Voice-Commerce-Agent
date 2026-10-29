/** Product photo rules shared by the picker (instant feedback) and the server action (enforced). */
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

export function photoProblem(file: { type: string; size: number }): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type))
    return 'Choose a JPEG, PNG or WebP photo (from your phone camera or gallery).';
  if (file.size > PHOTO_MAX_BYTES) return 'That photo is larger than 8 MB. Choose a smaller one.';
  return null;
}

/** Dashboard URL of a product photo; `version` busts the cache when the photo changes. */
export const photoUrl = (productId: string, version: string, size: 'thumb' | 'main' = 'main') =>
  `/products/${encodeURIComponent(productId)}/photo?size=${size}&v=${encodeURIComponent(version)}`;
