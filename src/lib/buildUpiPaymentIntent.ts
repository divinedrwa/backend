import { UPI_VPA_REGEX } from "./validateUpiVpa";

const VPA_REGEX = UPI_VPA_REGEX;

/** Max transaction note length per NPCI UPI link spec. */
const MAX_TN_LENGTH = 50;

/**
 * Resolve a canonical `upi://pay?...` URI from a decoded QR payload (URI or Bharat EMVCo).
 */
export function resolveUpiPayUriFromPayload(payload: string): string | null {
  const trimmed = payload.trim();
  if (!trimmed) return null;

  if (/^upi:\/\/pay/i.test(trimmed)) {
    return trimmed.split("#")[0];
  }

  if (trimmed.startsWith("000201")) {
    const fromEmbedded = buildUpiUriFromEmbeddedParams(trimmed);
    const fromTlv = extractUpiPayUriFromEmvco(trimmed);
    if (fromEmbedded && fromEmbedded.includes("mc=")) return fromEmbedded;
    if (fromTlv) return fromTlv;
    return fromEmbedded;
  }

  if (/pa=/i.test(trimmed)) {
    return `upi://pay?${trimmed.replace(/^\?/, "")}`;
  }

  return null;
}

function extractUpiPayUriFromEmvco(data: string): string | null {
  let i = 0;
  while (i + 4 <= data.length) {
    const tag = data.substring(i, i + 2);
    i += 2;
    const len = parseInt(data.substring(i, i + 2), 10);
    i += 2;
    if (Number.isNaN(len) || i + len > data.length) break;
    const value = data.substring(i, i + len);
    i += len;

    if (tag === "26" || tag === "27") {
      const nested = parseNestedTlv(value);
      const fromNested = upiUriFromEmvcoMerchantBlock(nested, value);
      if (fromNested) return fromNested;
    }
  }
  return null;
}

/** Tag 26/27: sub 00 = upi://pay, sub 01 = pa=...&pn=...&mc=... */
function upiUriFromEmvcoMerchantBlock(
  nested: Record<string, string>,
  rawValue: string,
): string | null {
  const guid = nested["00"]?.trim();
  const merchantInfo = nested["01"]?.trim();

  if (merchantInfo && /^upi:\/\/pay/i.test(merchantInfo)) {
    return merchantInfo.split("#")[0];
  }

  if (merchantInfo && /pa=/i.test(merchantInfo)) {
    const base = guid && /^upi:\/\//i.test(guid) ? guid.split("?")[0] : "upi://pay";
    const query = merchantInfo.startsWith("?") ? merchantInfo.slice(1) : merchantInfo;
    return `${base}?${query}`;
  }

  if (/^upi:\/\/pay/i.test(rawValue)) {
    return rawValue.split("#")[0];
  }

  const pa = extractPaFromString(rawValue);
  if (!pa) return null;

  const params = new URLSearchParams();
  params.set("pa", pa);
  const pn = extractParamFromString(rawValue, "pn");
  if (pn) params.set("pn", decodeURIComponent(pn));
  const mc = extractParamFromString(rawValue, "mc");
  if (mc) params.set("mc", mc);
  const tid = extractParamFromString(rawValue, "tid");
  if (tid) params.set("tid", tid);
  return `upi://pay?${params.toString()}`;
}

function parseNestedTlv(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= value.length) {
    const tag = value.substring(i, i + 2);
    i += 2;
    const len = parseInt(value.substring(i, i + 2), 10);
    i += 2;
    if (Number.isNaN(len) || i + len > value.length) break;
    out[tag] = value.substring(i, i + len);
    i += len;
  }
  return out;
}

function buildUpiUriFromEmbeddedParams(raw: string): string | null {
  const pa = extractPaFromString(raw);
  if (!pa) return null;

  const params = new URLSearchParams();
  params.set("pa", pa);

  const pn = extractParamFromString(raw, "pn");
  if (pn) params.set("pn", decodeURIComponent(pn));

  const mc = extractParamFromString(raw, "mc");
  if (mc) params.set("mc", mc);

  const tid = extractParamFromString(raw, "tid");
  if (tid) params.set("tid", tid);

  const mode = extractParamFromString(raw, "mode");
  if (mode) params.set("mode", mode);

  return `upi://pay?${params.toString()}`;
}

function extractPaFromString(value: string): string | undefined {
  const match = value.match(/pa=([a-zA-Z0-9.\-_]{2,256}@[a-zA-Z0-9.\-_]{2,64})/i);
  if (!match?.[1]) return undefined;
  const vpa = decodeURIComponent(match[1].trim());
  return VPA_REGEX.test(vpa) ? vpa : undefined;
}

function extractParamFromString(value: string, key: string): string | undefined {
  const re = new RegExp(`${key}=([^&\\s#]+)`, "i");
  const match = value.match(re);
  if (!match?.[1]) return undefined;
  const raw = match[1].trim();
  // Stop if value runs into the next EMVCo TLV tag (two digits + two digit length).
  const tlvNoise = raw.match(/^(.+?)(?=\d{4}[a-z]{2,}|\d{4}52|\d{4}53)/i);
  return (tlvNoise?.[1] ?? raw).trim();
}

function sanitizeTransactionNote(remark: string): string {
  return remark
    .trim()
    .replace(/\//g, "-")
    .replace(/\s+/g, " ")
    .slice(0, MAX_TN_LENGTH);
}

/** Replace only am/cu/tn on a URI, keeping every other param byte-for-byte. */
function replaceTransactionFields(uri: string, amount: string, tn: string): string {
  const noFragment = uri.split("#")[0];
  const qIndex = noFragment.indexOf("?");
  const path = noFragment.slice(0, qIndex);
  const query = noFragment.slice(qIndex + 1);

  const kept = query
    .split("&")
    .filter(Boolean)
    .filter((p) => {
      const key = p.split("=")[0].toLowerCase();
      return key !== "am" && key !== "cu" && key !== "tn";
    });

  kept.push(`am=${amount}`, "cu=INR");
  if (tn) kept.push(`tn=${encodeURIComponent(tn)}`);

  return `${path}?${kept.join("&")}`;
}

/**
 * Build a UPI app intent URI.
 *
 * For a bank/merchant QR the original payload is replayed *verbatim* — every
 * field (pa, pn, mc, mode, purpose, sign, orgid, tid…) is kept byte-for-byte
 * and only am/cu/tn are set. This keeps the transaction person-to-merchant
 * (P2M): dropping mc/mode/purpose would downgrade it to P2P and hit NPCI's
 * per-payee "max payments in 24 hours" inbound cap, and re-encoding a base64
 * `sign` would break merchant verification. Verified end-to-end 2026-07-01
 * with the society's Bank of Maharashtra merchant QR. A manual VPA (no
 * merchant payload) falls back to a plain P2P intent, which is correct for a
 * personal address.
 */
export function buildUpiPaymentIntentUri(input: {
  upiPayUri?: string | null;
  upiPayload?: string | null;
  vpa: string;
  payeeName?: string | null;
  amount: number;
  remark: string;
}): string {
  const remark = sanitizeTransactionNote(input.remark);
  const amount = input.amount.toFixed(2);
  const resolved =
    (input.upiPayUri?.trim() && resolveUpiPayUriFromPayload(input.upiPayUri)) ||
    (input.upiPayload?.trim() && resolveUpiPayUriFromPayload(input.upiPayload)) ||
    null;

  if (resolved && /^upi:\/\/pay\?/i.test(resolved)) {
    return replaceTransactionFields(resolved, amount, remark);
  }

  // No signed merchant payload → plain P2P intent.
  const parts = [`pa=${input.vpa.trim()}`];
  if (input.payeeName?.trim()) parts.push(`pn=${encodeURIComponent(input.payeeName.trim())}`);
  parts.push(`am=${amount}`, "cu=INR");
  if (remark) parts.push(`tn=${encodeURIComponent(remark)}`);
  return `upi://pay?${parts.join("&")}`;
}
