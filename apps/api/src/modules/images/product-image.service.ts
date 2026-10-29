import { randomUUID } from 'node:crypto';
import type { AuditService } from '@vca/commerce';
import type { Database, ProductImage } from '@vca/database';
import { NotFoundError, ValidationError, type Logger } from '@vca/shared';
import { processProductImage } from './image-processing';
import type { ObjectStore } from './object-store';

export type ImageVariant = 'main' | 'thumb';

export interface StoredImage {
  bytes: Buffer;
  mimeType: string;
  /** Changes with every new photo: used for cache busting and ETags. */
  version: string;
}

/**
 * Product photos: validated and resized here, stored in Cloudflare R2 when configured (private
 * bucket, served through the API) or in Postgres otherwise. Every operation is scoped to the
 * merchant that owns the product, so one shop can never read, replace or delete another's photo.
 */
export class ProductImageService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
    private readonly logger: Logger,
    private readonly store: ObjectStore | null,
    private readonly maxUploadBytes: number,
  ) {}

  get storage(): 'R2' | 'DATABASE' {
    return this.store ? 'R2' : 'DATABASE';
  }

  private async product(merchantId: string, productId: string) {
    const product = await this.db.product.findFirst({ where: { id: productId, merchantId } });
    if (!product) throw new NotFoundError('Product', productId);
    return product;
  }

  /** Replaces (or adds) the product's photo. The previous objects are deleted afterwards. */
  async save(merchantId: string, productId: string, upload: Buffer, by = 'dashboard') {
    const product = await this.product(merchantId, productId);
    if (!upload.length) throw new ValidationError('Choose a photo first.');
    if (upload.length > this.maxUploadBytes)
      throw new ValidationError(
        `Photos must be ${Math.round(this.maxUploadBytes / 1_048_576)} MB or smaller.`,
      );
    const image = await processProductImage(upload);
    const previous = await this.db.productImage.findUnique({ where: { productId } });

    let row: ProductImage;
    if (this.store) {
      const base = `merchants/${merchantId}/products/${productId}/${randomUUID()}`;
      const objectKey = `${base}.jpg`;
      const thumbKey = `${base}-thumb.jpg`;
      await this.store.put(objectKey, image.main, image.mimeType);
      try {
        await this.store.put(thumbKey, image.thumb, image.mimeType);
      } catch (error) {
        await this.store.delete(objectKey).catch(() => undefined);
        throw error;
      }
      const fields = {
        storage: 'R2' as const,
        mimeType: image.mimeType,
        objectKey,
        thumbKey,
        data: null,
        thumbData: null,
        sizeBytes: image.main.length,
        width: image.width,
        height: image.height,
      };
      try {
        row = await this.db.productImage.upsert({
          where: { productId },
          update: fields,
          create: { productId, ...fields },
        });
      } catch (error) {
        // The database never pointed at the new objects: remove them so nothing is orphaned.
        await this.deleteObjects(objectKey, thumbKey);
        throw error;
      }
    } else {
      const fields = {
        storage: 'DATABASE' as const,
        mimeType: image.mimeType,
        // Prisma's Bytes type is a plain Uint8Array over an ArrayBuffer.
        data: new Uint8Array(image.main),
        thumbData: new Uint8Array(image.thumb),
        objectKey: null,
        thumbKey: null,
        sizeBytes: image.main.length,
        width: image.width,
        height: image.height,
      };
      row = await this.db.productImage.upsert({
        where: { productId },
        update: fields,
        create: { productId, ...fields },
      });
    }
    if (previous?.storage === 'R2') await this.deleteObjects(previous.objectKey, previous.thumbKey);
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'product.photo_updated',
      entityType: 'product',
      entityId: product.id,
      data: {
        product: product.name,
        storage: row.storage,
        sizeBytes: row.sizeBytes,
        width: image.width,
        height: image.height,
        by,
      },
    });
    return { storage: row.storage, sizeBytes: row.sizeBytes, width: row.width, height: row.height };
  }

  async remove(merchantId: string, productId: string, by = 'dashboard'): Promise<boolean> {
    const product = await this.product(merchantId, productId);
    const image = await this.db.productImage.findUnique({ where: { productId } });
    if (!image) return false;
    await this.db.productImage.delete({ where: { id: image.id } });
    if (image.storage === 'R2') await this.deleteObjects(image.objectKey, image.thumbKey);
    await this.audit.record({
      merchantId,
      actor: 'MERCHANT',
      type: 'product.photo_removed',
      entityType: 'product',
      entityId: product.id,
      data: { product: product.name, by },
    });
    return true;
  }

  /** The photo's bytes (main or thumbnail), or null if the product has none. */
  async read(
    merchantId: string,
    productId: string,
    variant: ImageVariant = 'main',
  ): Promise<StoredImage | null> {
    const image = await this.db.productImage.findFirst({
      where: { productId, product: { merchantId } },
    });
    if (!image) return null;
    const version = `${image.id}-${image.updatedAt.getTime()}`;
    if (image.storage === 'DATABASE') {
      // Photos uploaded before thumbnails existed have only the main image.
      const bytes = variant === 'thumb' ? (image.thumbData ?? image.data) : image.data;
      return bytes ? { bytes: Buffer.from(bytes), mimeType: image.mimeType, version } : null;
    }
    if (!this.store) {
      this.logger.warn({ productId }, 'photo is in R2 but R2 is not configured');
      return null;
    }
    const key = variant === 'thumb' ? (image.thumbKey ?? image.objectKey) : image.objectKey;
    const bytes = key ? await this.store.get(key) : null;
    return bytes ? { bytes, mimeType: image.mimeType, version } : null;
  }

  private async deleteObjects(...keys: (string | null)[]) {
    for (const key of keys) {
      if (!key || !this.store) continue;
      // An object left behind only costs storage; it is logged for cleanup, never fatal.
      await this.store
        .delete(key)
        .catch((error: unknown) =>
          this.logger.warn({ err: error, key }, 'could not delete old photo object'),
        );
    }
  }
}
