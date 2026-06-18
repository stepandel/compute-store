import { createHash } from "node:crypto";
import { checkoutMethods, quoteCheckout, type CheckoutQuote } from "@/lib/checkout";
import { product } from "@/lib/config";
import { parseCreateMachineRequest } from "@/lib/validation";

// Our MPP product type, surfaced by the validate endpoint (PostalForm returns
// "order"/"flower_letter"; ours is a machine lease).
export const PRODUCT_TYPE = "machine_lease";

// Canonical MPP order paths (literal mirror of PostalForm's machine endpoints).
export const ORDERS_PATH = "/api/machine/mpp/orders";
export const ORDERS_VALIDATE_PATH = "/api/machine/mpp/orders/validate";

// Deterministically derive the order id from the buyer's request_id (the MPP
// idempotency key). The same request_id always maps to the same order id across
// validate → create → pay → poll, which is how a retried paid call resolves to
// the already-provisioned lease instead of creating a second machine.
export function deriveOrderId(requestId: string): string {
  return `order_${createHash("sha256").update(requestId).digest("hex").slice(0, 24)}`;
}

export type ValidateOrderResult = {
  protocol: "mpp";
  methods: string[];
  product_type: string;
  quote: CheckoutQuote;
  request_id: string;
};

// Preflight: validate the order body and return the quote + accepted methods.
// Requires a UUID request_id (MPP order flow). Throws ValidationError on a bad
// body. Pure — composes no payment and creates no machine.
export function validateOrder(payload: unknown): ValidateOrderResult {
  const request = parseCreateMachineRequest(payload, product, { requireRequestId: true });
  return {
    protocol: "mpp",
    methods: checkoutMethods(),
    product_type: PRODUCT_TYPE,
    quote: quoteCheckout(request),
    // requireRequestId guarantees this is present.
    request_id: request.requestId!,
  };
}

export function serviceUrlFromRequest(request: Request): string {
  if (process.env.NEXT_PUBLIC_STORE_URL) {
    return process.env.NEXT_PUBLIC_STORE_URL;
  }
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (forwardedHost) {
    const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
    return `${forwardedProto}://${forwardedHost}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return "http://localhost:3000";
}
