import Razorpay from "razorpay";

let client: Razorpay | null = null;

function getClient(): Razorpay | null {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return null;
  if (!client) {
    client = new Razorpay({ key_id: id, key_secret: secret });
  }
  return client;
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function createMaintenanceOrder(params: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}) {
  const rzp = getClient();
  if (!rzp) {
    throw Object.assign(new Error("Razorpay not configured"), { code: "GATEWAY_MISSING" });
  }
  const order = await rzp.orders.create({
    amount: Math.max(100, Math.round(params.amountPaise)),
    currency: process.env.RAZORPAY_CURRENCY ?? "INR",
    receipt: params.receipt.slice(0, 40),
    notes: params.notes,
  });
  return order;
}

export function getPublishableKey(): string | undefined {
  return process.env.RAZORPAY_KEY_ID;
}
