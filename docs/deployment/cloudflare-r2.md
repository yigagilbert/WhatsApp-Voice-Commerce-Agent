# Product photos and Cloudflare R2

Merchants add a photo when they create or edit a product in the dashboard (**Products → Add
product**, or open any product). Customers see it on WhatsApp when they ask about the product, and
the products grid shows a thumbnail.

## How it works

```
Dashboard (browser) ──form upload──▶ Next.js server action ──base64──▶ API  PUT /api/products/:id/image
                                                                         │ validate (decode with sharp)
                                                                         │ rotate, strip EXIF/GPS, resize
                                                                         │ main ≤1600 px JPEG + 320 px thumbnail
                                                                         ▼
                                              Cloudflare R2 (private bucket)   or   Postgres (fallback)
                                                                         │
Dashboard <img> ◀── /products/:id/photo (session-checked proxy) ◀── API  GET /api/products/:id/image?size=thumb|main
WhatsApp customer ◀── worker ◀── API (catalog photo, only for active, visible products)
```

- **Credentials never reach the browser.** Only the API holds R2 keys; the dashboard calls the API
  server-side with the dashboard user's session.
- **The bucket stays private.** No public bucket, custom domain or CORS rule is needed: photos are
  served through the API with `ETag` and `304 Not Modified`, and cached privately by browsers.
- **Merchant isolation.** Object keys are `merchants/<merchantId>/products/<productId>/<uuid>.jpg`
  (and `-thumb.jpg`); every read, replace and delete is scoped to the signed-in merchant.
- **Unique keys per upload.** Replacing a photo writes new objects, commits the database row, then
  deletes the old objects. If the upload fails part-way, the new objects are removed and the
  current photo stays.
- **Validation.** The API decodes every file — the name and declared type are not trusted. JPEG, PNG and
  WebP are accepted (the API also decodes AVIF); files under 64 px or above `IMAGE_MAX_UPLOAD_BYTES` (8 MB) are
  rejected. The dashboard checks type and size before uploading.
- **Database records.** `ProductImage` stores the storage kind, object keys, dimensions, size and an
  updated timestamp (used as the cache version). Existing photos stored in Postgres keep working.
- **Audit.** `product.photo_updated` and `product.photo_removed` events record who changed a photo.

## Choosing the storage

| `IMAGE_STORAGE`  | Behaviour                                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | R2 when `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and `R2_BUCKET` are set; otherwise Postgres |
| `r2`             | R2 required: the API refuses to start without the R2 values                                                     |
| `database`       | Always Postgres (`bytea`), e.g. for local development                                                           |

The API logs the storage in use at startup (`productImages: "R2"` or `"DATABASE"`).

## What you need to provide

1. **A Cloudflare account with R2 enabled** (R2 → _Purchase R2 Plan_; the free tier covers 10 GB
   of storage and has no egress fees).
2. **A bucket**, e.g. `katale-products`. Keep _Public access_ **off**. Location hint: the region
   closest to the API server.
3. **An R2 API token**: R2 → _Manage R2 API Tokens_ → _Create API token_ → permission
   **Object Read & Write**, **applied to the one bucket**, no expiry or one you will rotate. Copy
   the **Access Key ID** and **Secret Access Key** (shown once).
4. **Your account ID** (R2 overview page, right column).

Then add to the server's `.env` (never to Git, never to the web app):

```bash
IMAGE_STORAGE=auto
R2_ACCOUNT_ID=<account id>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=katale-products
```

Restart the API. Photos uploaded before the switch stay in Postgres and keep working; new and
replaced photos go to R2.

## Checking it

1. Dashboard → Products → open a product → choose a photo → **Save changes**.
2. The photo appears in the editor and the grid; the product's detail (`GET /api/products/:id`)
   reports `image.storage: "R2"`.
3. In Cloudflare, the bucket shows two objects under `merchants/<id>/products/<productId>/`.
4. Replace the photo: two new objects, the old ones are gone. Remove it: the folder is empty.

## Testing without Cloudflare

Any S3-compatible server works. With MinIO:

```bash
docker run -d --name katale-minio -p 127.0.0.1:9100:9000 \
  -e MINIO_ROOT_USER=katale-test -e MINIO_ROOT_PASSWORD=katale-test-secret-123 \
  minio/minio server /data
docker exec katale-minio mc alias set local http://localhost:9000 katale-test katale-test-secret-123
docker exec katale-minio mc mb local/katale-products
```

```bash
IMAGE_STORAGE=r2 R2_ENDPOINT=http://127.0.0.1:9100 R2_ACCESS_KEY_ID=katale-test \
  R2_SECRET_ACCESS_KEY=katale-test-secret-123 R2_BUCKET=katale-products pnpm --filter api dev
```

Automated coverage: `apps/api/src/modules/images/images.test.ts` (processing, SigV4 signing, URLs,
errors) and `tests/integration/product-images.test.ts` (create/edit, upload, replace, failure
cleanup, merchant isolation, WhatsApp visibility, database fallback).

## Costs and limits

- R2 storage: each photo is roughly 50–300 KB plus a ~10 KB thumbnail. 1,000 products ≈ under 300 MB.
- Every dashboard view and WhatsApp send reads through the API; thumbnails are cached for a day in
  the browser and revalidated with `ETag`. At demo and single-merchant scale this is negligible.
- Rotating the token: create a new token, update `.env`, restart the API, then delete the old token.
