/**
 * Decode a UPI QR image and print its raw payload + a merchant/P2P diagnosis.
 *
 *   npx tsx scripts/decode-upi-qr.ts <path-to-qr-image>
 *
 * Use the exact QR the admin uploaded / the one that works when scanned.
 */
import fs from "node:fs";
import jsQR from "jsqr";
import sharp from "sharp";
import { resolveUpiPayUriFromPayload } from "../src/lib/buildUpiPaymentIntent";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: npx tsx scripts/decode-upi-qr.ts <image>");
    process.exit(1);
  }

  const buf = fs.readFileSync(path);
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const code = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  if (!code?.data) {
    console.error("No QR code found in the image.");
    process.exit(1);
  }

  const raw = code.data;
  const has = (k: string) => new RegExp(`(?:^|[?&])${k}=`, "i").test(raw);

  console.log("=== RAW QR STRING ===");
  console.log(raw);
  console.log("\n=== FORMAT ===");
  console.log(
    /^upi:\/\/pay/i.test(raw)
      ? "upi:// intent QR"
      : raw.startsWith("000201")
        ? "EMVCo / Bharat QR"
        : "other",
  );
  console.log("\n=== FIELDS PRESENT ===");
  for (const k of ["pa", "pn", "mc", "mode", "tid", "tr", "sign", "orgid", "am"]) {
    console.log(`  ${k.padEnd(6)}: ${has(k) ? "yes" : "-"}`);
  }
  console.log("\n=== VERDICT ===");
  if (has("sign")) {
    console.log("SIGNED MERCHANT QR — has a signature. Fixable in software (replay sign → P2M).");
  } else if (has("mc")) {
    console.log("Has mc but NO sign — verified-merchant lookup by VPA; may work as P2M via bare intent.");
  } else {
    console.log("NO sign, NO mc — looks like a PERSONAL (P2P) VPA. The 24h cap is an NPCI limit; a merchant/business UPI is required.");
  }
  console.log("\n=== resolved upiPayUri (what the app would replay) ===");
  console.log(resolveUpiPayUriFromPayload(raw) ?? "(could not resolve)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
