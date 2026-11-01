import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

/**
 * WhatsApp Status advert images: 1080 × 1920 (9:16, what Status shows full screen), drawn as SVG
 * around the product's real photo and rendered with resvg like the report charts. Everything
 * printed comes from the caller: the price is the catalogue's, formatted by the caller.
 */
const require = createRequire(import.meta.url);
const FONT_FILES = [
  require.resolve('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf'),
  require.resolve('@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf'),
  require.resolve('@expo-google-fonts/inter/800ExtraBold/Inter_800ExtraBold.ttf'),
];

export const STATUS_W = 1080;
export const STATUS_H = 1920;
const PHOTO = 920;

export const THEMES = [
  {
    name: 'Teal',
    bg: '#0f766e',
    text: '#ffffff',
    muted: '#ccfbf1',
    pill: '#fde68a',
    pillText: '#422006',
  },
  {
    name: 'Night',
    bg: '#1e293b',
    text: '#ffffff',
    muted: '#cbd5e1',
    pill: '#f59e0b',
    pillText: '#1c1917',
  },
  {
    name: 'Clay',
    bg: '#9a3412',
    text: '#ffffff',
    muted: '#fed7aa',
    pill: '#ffffff',
    pillText: '#7c2d12',
  },
  {
    name: 'Paper',
    bg: '#f8fafc',
    text: '#0f172a',
    muted: '#475569',
    pill: '#0f766e',
    pillText: '#ffffff',
  },
] as const;

export interface StatusImageInput {
  shopName: string;
  headline: string;
  productName: string;
  /** Catalogue price, already formatted (e.g. "USD 18.50"). */
  price: string;
  cta: string;
  theme: number;
  /** The product photo (any format sharp reads). */
  photo: Buffer;
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

/**
 * Greedy word wrap by estimated width (Inter averages ~0.56 em per character). Words longer than
 * a line are cut; text beyond `maxLines` ends with an ellipsis.
 */
export function wrapText(text: string, fontSize: number, maxWidth: number, maxLines: number) {
  const perLine = Math.max(4, Math.floor(maxWidth / (fontSize * 0.56)));
  const lines: string[] = [];
  let line = '';
  for (const raw of text.trim().split(/\s+/).filter(Boolean)) {
    const word = raw.length > perLine ? `${raw.slice(0, perLine - 1)}…` : raw;
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1]!;
    kept[maxLines - 1] = `${last.slice(0, perLine - 1).trimEnd()}…`;
    return kept;
  }
  return lines;
}

const textLines = (
  lines: string[],
  opts: { x: number; y: number; size: number; weight: number; fill: string; lineHeight: number },
) =>
  lines
    .map(
      (l, i) =>
        `<text x="${opts.x}" y="${opts.y + i * opts.lineHeight}" text-anchor="middle" font-family="Inter" font-weight="${opts.weight}" font-size="${opts.size}" fill="${opts.fill}">${esc(l)}</text>`,
    )
    .join('');

/** Renders the advert as a JPEG (WhatsApp recompresses PNGs anyway). */
export async function renderStatusImage(input: StatusImageInput): Promise<Buffer> {
  const theme = THEMES[Math.abs(input.theme) % THEMES.length]!;
  const photo = await sharp(input.photo, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize(PHOTO, PHOTO, { fit: 'cover', position: 'attention' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 85 })
    .toBuffer();
  const cx = STATUS_W / 2;
  const photoX = (STATUS_W - PHOTO) / 2;
  const photoY = 400;

  const headline = wrapText(input.headline, 76, STATUS_W - 140, 2);
  const name = wrapText(input.productName, 54, STATUS_W - 160, 2);
  const nameY = photoY + PHOTO + 110;
  const priceY = nameY + (name.length - 1) * 66 + 70;
  const priceW = Math.min(STATUS_W - 200, Math.max(260, input.price.length * 30 + 100));
  const ctaY = STATUS_H - 190;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${STATUS_W}" height="${STATUS_H}" viewBox="0 0 ${STATUS_W} ${STATUS_H}">
<rect width="${STATUS_W}" height="${STATUS_H}" fill="${theme.bg}"/>
<text x="${cx}" y="140" text-anchor="middle" font-family="Inter" font-weight="600" font-size="34" letter-spacing="4" fill="${theme.muted}">${esc(input.shopName.toUpperCase().slice(0, 40))}</text>
${textLines(headline, { x: cx, y: headline.length > 1 ? 250 : 300, size: 76, weight: 800, fill: theme.text, lineHeight: 88 })}
<defs><clipPath id="photo"><rect x="${photoX}" y="${photoY}" width="${PHOTO}" height="${PHOTO}" rx="36"/></clipPath></defs>
<image x="${photoX}" y="${photoY}" width="${PHOTO}" height="${PHOTO}" clip-path="url(#photo)" xlink:href="data:image/jpeg;base64,${photo.toString('base64')}"/>
${textLines(name, { x: cx, y: nameY, size: 54, weight: 600, fill: theme.text, lineHeight: 66 })}
<rect x="${cx - priceW / 2}" y="${priceY}" width="${priceW}" height="84" rx="42" fill="${theme.pill}"/>
<text x="${cx}" y="${priceY + 57}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="46" fill="${theme.pillText}">${esc(input.price)}</text>
<rect x="80" y="${ctaY}" width="${STATUS_W - 160}" height="110" rx="55" fill="none" stroke="${theme.text}" stroke-width="4"/>
<text x="${cx}" y="${ctaY + 70}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="42" fill="${theme.text}">${esc(input.cta)}</text>
</svg>`;
  const png = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Inter' },
    fitTo: { mode: 'width', value: STATUS_W },
  })
    .render()
    .asPng();
  return sharp(png).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
