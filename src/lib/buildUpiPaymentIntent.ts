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

/**
 * Build a UPI app intent URI as a plain P2P request (pa/pn/am/cu/tn only).
 *
 * Merchant fields from the bank QR (mc, tid, mode, sign, orgid…) are dropped on
 * purpose: an intent carrying `mc` is treated as a verified-merchant (P2M)
 * payment by GPay/PhonePe/Paytm and is refused unless it also carries the
 * original merchant signature (`sign`), which a reconstructed URI cannot
 * reproduce. The exact `pa`/`pn` are still taken from the decoded QR when
 * available, since the separately-parsed `vpa` can be truncated for unusual
 * merchant VPAs.
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
  const resolved =
    (input.upiPayUri?.trim() && resolveUpiPayUriFromPayload(input.upiPayUri)) ||
    (input.upiPayload?.trim() && resolveUpiPayUriFromPayload(input.upiPayload)) ||
    null;

  let pa = input.vpa.trim();
  let pn = input.payeeName?.trim() ?? "";
  if (resolved) {
    const src = new URL(resolved);
    const srcPa = src.searchParams.get("pa")?.trim();
    if (srcPa) pa = srcPa;
    const srcPn = src.searchParams.get("pn")?.trim();
    if (!pn && srcPn) pn = srcPn;
  }

  const url = new URL("upi://pay");
  url.searchParams.set("pa", pa);
  if (pn) url.searchParams.set("pn", pn);
  url.searchParams.set("am", input.amount.toFixed(2));
  url.searchParams.set("tn", remark);
  url.searchParams.set("cu", "INR");

  return url.toString();
}
