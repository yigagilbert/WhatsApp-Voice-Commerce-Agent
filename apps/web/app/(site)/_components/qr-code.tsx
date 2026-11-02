import QRCode from 'qrcode';

/** A QR code for `url`, rendered on the server as inline SVG (no client JavaScript). */
export async function QrCode({ url, label }: { url: string; label: string }) {
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#1c2329', light: '#ffffff' },
  });
  return <div role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
