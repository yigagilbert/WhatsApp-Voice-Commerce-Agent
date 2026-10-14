/**
 * Maps what a merchant says ("DHL", "FedEx", "Posta Uganda") to PayPal's carrier codes.
 * Only codes verified against PayPal's Orders v2 `shipment_carrier` enum are listed; anything
 * else is sent as `OTHER` with the merchant's own carrier name (`carrier_name_other`), which
 * PayPal accepts for any carrier. Codes are also valid in disputes' `tracking_info.carrier_name`
 * where listed there (DHL, UPS, FEDEX, USPS, ROYAL_MAIL, PARCELFORCE, OTHER).
 */
const KNOWN: Record<string, string> = {
  DHL: 'DHL',
  'DHL EXPRESS': 'DHL',
  UPS: 'UPS',
  FEDEX: 'FEDEX',
  'FED EX': 'FEDEX',
  'FEDERAL EXPRESS': 'FEDEX',
  USPS: 'USPS',
  'US POSTAL SERVICE': 'USPS',
  ARAMEX: 'ARAMEX',
  TNT: 'TNT',
  DPD: 'DPD',
  GLS: 'GLS',
  EMS: 'EMS',
  'ROYAL MAIL': 'ROYAL_MAIL',
  PARCELFORCE: 'PARCELFORCE',
};

const LABELS: Record<string, string> = {
  FEDEX: 'FedEx',
  ROYAL_MAIL: 'Royal Mail',
  PARCELFORCE: 'Parcelforce',
  ARAMEX: 'Aramex',
};

export interface CarrierChoice {
  /** PayPal carrier code. */
  carrier: string;
  /** Set when carrier = OTHER: the merchant's carrier name. */
  carrierNameOther?: string;
  /** Human label for summaries ("DHL", "Posta Uganda"). */
  label: string;
}

export function normalizeCarrier(input: string): CarrierChoice {
  const name = input.trim().replace(/\s+/g, ' ');
  const key = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim();
  const code = KNOWN[key] ?? (KNOWN[key.replace(/ /g, '')] as string | undefined);
  if (code) return { carrier: code, label: LABELS[code] ?? code };
  return { carrier: 'OTHER', carrierNameOther: name.slice(0, 64), label: name };
}

/** Carrier codes accepted in a dispute's evidence `tracking_info.carrier_name`. */
const DISPUTE_CARRIERS = new Set([
  'DHL',
  'UPS',
  'FEDEX',
  'USPS',
  'ROYAL_MAIL',
  'PARCELFORCE',
  'OTHER',
]);
export const disputeCarrierName = (carrier: string) =>
  DISPUTE_CARRIERS.has(carrier) ? carrier : 'OTHER';
