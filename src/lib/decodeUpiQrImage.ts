import jsQR from "jsqr";
import sharp from "sharp";
import { UPI_VPA_REGEX } from "./validateUpiVpa";
import { resolveUpiPayUriFromPayload } from "./buildUpiPaymentIntent";

const VPA_REGEX = UPI_VPA_REGEX;

/** Parsed UPI details extracted from a bank QR image or payload string. */
export type ParsedUpiQr = {
  vpa: string;
  payeeName?: string;
  upiPayload: string;
  hasFixedAmount: boolean;
  fixedAmount?: string;
};

/**
 * Decode a QR image buffer and extract UPI payment details.
 * Supports direct `upi://pay` payloads and Bharat QR (EMVCo) bank codes.
 */
export async function decodeUpiQrFromImageBuffer(buffer: Buffer): Promise<ParsedUpiQr> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!code?.data) {
    throw new Error("No QR code found in the image. Use a clear photo of your bank UPI QR.");
  }

  return parseUpiQrPayload(code.data);
}

/**
 * Parse a UPI QR payload string (from decoded QR or manual input).
 */
export function parseUpiQrPayload(raw: string): ParsedUpiQr {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("QR code payload is empty");
  }

  if (/^upi:\/\/pay/i.test(trimmed)) {
    return parseUpiPayUri(trimmed);
  }

  if (trimmed.startsWith("000201")) {
    const emv = parseEmvcoBharatQr(trimmed);
    if (emv.vpa) {
      return {
        vpa: emv.vpa,
        payeeName: emv.payeeName,
        upiPayload: trimmed,
        hasFixedAmount: Boolean(emv.fixedAmount),
        fixedAmount: emv.fixedAmount,
      };
    }
  }

  // Some QRs embed pa= inside a longer string
  const embeddedPa = extractPaFromString(trimmed);
  if (embeddedPa) {
    const pn = extractParamFromString(trimmed, "pn");
    return {
      vpa: embeddedPa,
      payeeName: pn ? decodeURIComponent(pn) : undefined,
      upiPayload: trimmed,
      hasFixedAmount: Boolean(extractParamFromString(trimmed, "am")),
      fixedAmount: extractParamFromString(trimmed, "am") ?? undefined,
    };
  }

  throw new Error(
    "This QR is not a valid UPI payment code. Upload the QR provided by your bank for UPI collections.",
  );
}

function parseUpiPayUri(uri: string): ParsedUpiQr {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new Error("Invalid UPI payment URI in QR code");
  }

  if (url.protocol !== "upi:" || url.hostname !== "pay") {
    throw new Error("QR code is not a UPI payment QR (expected upi://pay)");
  }

  const vpa = url.searchParams.get("pa")?.trim();
  if (!vpa || !VPA_REGEX.test(vpa)) {
    throw new Error("QR code does not contain a valid UPI VPA (pa=)");
  }

  const payeeName = url.searchParams.get("pn")?.trim();
  const fixedAmount = url.searchParams.get("am")?.trim();

  return {
    vpa,
    payeeName: payeeName ? decodeURIComponent(payeeName) : undefined,
    upiPayload: uri,
    hasFixedAmount: Boolean(fixedAmount),
    fixedAmount: fixedAmount || undefined,
  };
}

type EmvcoFields = {
  vpa?: string;
  payeeName?: string;
  fixedAmount?: string;
};

/** Parse NPCI Bharat QR (EMVCo TLV, payload starts with 000201). */
function parseEmvcoBharatQr(data: string): EmvcoFields {
  const fields: EmvcoFields = {};
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
      const upiUri = nested["00"] ?? nested["01"] ?? value;
      if (/^upi:\/\/pay/i.test(upiUri)) {
        try {
          const parsed = parseUpiPayUri(upiUri);
          fields.vpa = parsed.vpa;
          fields.payeeName = fields.payeeName ?? parsed.payeeName;
          fields.fixedAmount = fields.fixedAmount ?? parsed.fixedAmount;
        } catch {
          // fall through to regex extraction
        }
      }
      const pa = extractPaFromString(value);
      if (pa) fields.vpa = pa;
      const pn = extractParamFromString(value, "pn");
      if (pn) fields.payeeName = decodeURIComponent(pn);
    }

    if (tag === "54") fields.fixedAmount = value;
    if (tag === "59") fields.payeeName = value;
  }

  return fields;
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
  const tlvNoise = raw.match(/^(.+?)(?=\d{4}[a-z]{2,}|\d{4}52|\d{4}53)/i);
  return (tlvNoise?.[1] ?? raw).trim();
}

/** Build PaymentMethod UPI_QR config fields after a successful decode + upload. */
export function buildUpiQrConfigFields(
  qrCodeUrl: string,
  parsed: ParsedUpiQr,
): Record<string, unknown> {
  const upiPayUri = resolveUpiPayUriFromPayload(parsed.upiPayload);
  return {
    qrCodeUrl,
    vpa: parsed.vpa,
    payeeName: parsed.payeeName ?? null,
    upiPayload: parsed.upiPayload,
    upiPayUri: upiPayUri ?? null,
    hasFixedAmount: parsed.hasFixedAmount,
    fixedAmount: parsed.fixedAmount ?? null,
    qrValidatedAt: new Date().toISOString(),
  };
}

export function isUpiQrConfigReady(config: Record<string, unknown>): boolean {
  return (
    typeof config.vpa === "string" &&
    config.vpa.length > 0 &&
    typeof config.qrValidatedAt === "string" &&
    config.qrValidatedAt.length > 0
  );
}
