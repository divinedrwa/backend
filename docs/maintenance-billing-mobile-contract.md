# Maintenance billing — mobile app integration (resident)

The mobile app must **not** compute cycle state, late fees, or payment eligibility. Call the backend (single source of truth) and render UI from the response.

## Base URL

Use the same API base as the rest of the app, e.g. `https://api.example.com/api` (including `/api` if that is your convention).

## Authentication

All endpoints below require `Authorization: Bearer <JWT>` except the payment gateway webhook (server-to-server).

## 1) Current cycle (resident / admin preview)

`GET /v1/cycles/current?societyId=<societyId>`

- `societyId` must match the JWT’s society (tampering returns **403**).
- Response fields (subset): `cycleId`, `title`, `amount`, `status` (**UPCOMING** | **OPEN** | **CLOSED**), `paymentStartDate`, `paymentEndDate`, `dueDate` (same as payment end — deadline **inclusive** for **OPEN**), `isPaid`, `lateFee`, `totalDue`, `effectiveLateFeeComponent`, `cycleKey`.

### UI behaviour (recommended)

| `status`   | Primary CTA        | Secondary copy                                       |
|-----------|---------------------|------------------------------------------------------|
| `OPEN`    | Enabled **Pay Now** | Pay before `<dueDate>` (format in locale) |
| `UPCOMING`| Disabled Pay        | Starts from `<paymentStartDate>`              |
| `CLOSED`  | Disabled Pay        | Window closed; optional offline contact text      |

> If policy allows late collection offline after close, gate that separately via admin/process — never flip trust to the device.

### When to call

- On app launch (home / billing screen focus).
- Pull-to-refresh on the billing screen.
- After returning from Razorpay (success / dismiss) — reconcile with backend.

---

## 2) Create Razorpay order (resident only)

`POST /v1/payments/create-order`

Body:

```json
{ "cycleId": "<billingCycleId>", "idempotencyKey": "optional-stable-string-per-attempt" }
```

Headers: Bearer token. Role must be **RESIDENT**.

Response (truncated):

```json
{
  "orderId": "order_...",
  "amountPaise": 250000,
  "currency": "INR",
  "key": "<publishable Razorpay key id>",
  "paymentId": "<internal_row_id>",
  "totalDue": 2500
}
```

- Open Razorpay Checkout with `{ key, amount: amountPaise, currency, order_id: orderId, ... }` per Razorpay mobile SDK docs.
- If `503` / `PAYMENT_GATEWAY_UNAVAILABLE`, show “online payment not configured” (do not compute totals locally).

---

## 3) Webhook (server only)

`POST https://<host>/api/v1/payments/webhook`

- Raw JSON body verified with Razorpay **webhook secret** (HMAC). **Clients never call this.**
- Idempotent on `paymentGatewayPaymentId`.

---

## 4) Invoice PDF (optional bonus)

`GET /v1/payments/<paymentRowId>/invoice.pdf`

Authenticated **RESIDENT**; only succeeds for **SUCCESS** payments owned by that user.

---

## Time zones

Timestamps returned are **UTC ISO8601**. Convert for display using the device locale / `timezone`.

---

## Do not implement on mobile

- Deriving OPEN / CLOSED / UPCOMING locally.
- Adding late fees in the client.
- Trusting Razorpay success alone — reconciliation is server-side (`payment.captured` webhook + polling where needed).

---

## PhonePe (resident)

`POST /v1/payments/phonepe/initiate` — body `{ "cycleId": "..." }`. Returns `redirectUrl`, `merchantTransactionId`.

`GET /v1/payments/phonepe/status/:txnId` — poll after redirect.

Server callback: `POST /api/v1/payments/phonepe/callback` (PhonePe → your API; requires `API_BASE_URL` on deploy).

Credentials: per-society **Payment methods → PhonePe** in admin, or global env fallback:

- `PHONEPE_MERCHANT_ID`, `PHONEPE_SALT_KEY`, `PHONEPE_SALT_INDEX`, `PHONEPE_ENVIRONMENT` (`SANDBOX` | `PRODUCTION`)
- `API_BASE_URL` — public origin (e.g. `https://gatepass-v037.onrender.com`)

---

## Operational env (backend)

- `REDIS_URL` — optional; cache falls back to in-memory TTL.
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` — Razorpay order + webhook verification.
- `PHONEPE_*`, `API_BASE_URL` — PhonePe pay + callback URLs (see above).

## Related

- **Flutter:** [../../divine_app/docs/APP.md](../../divine_app/docs/APP.md)
