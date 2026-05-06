import crypto from "crypto";

/** Razorpay signs the raw webhook POST body with the webhook secret. */
export function verifyRazorpayWebhookSignature(rawBody: Buffer, headerSignature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !headerSignature || rawBody.length === 0) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    if (digest.length !== headerSignature.length) return false;
    return crypto.timingSafeEqual(Buffer.from(digest, "utf8"), Buffer.from(headerSignature, "utf8"));
  } catch {
    return false;
  }
}
