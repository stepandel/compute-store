import { NextResponse, after } from "next/server";
import { Errors } from "mppx";
import {
  CheckoutConfigurationError,
  checkoutComposeEntries,
  createMppCheckout,
  quoteCheckout,
} from "@/lib/checkout";
import { product } from "@/lib/config";
import { deriveOrderId, serviceUrlFromRequest } from "@/lib/orders";
import { toMppOrder } from "@/lib/models";
import { createMachineService } from "@/lib/service";
import { enforceRateLimit } from "@/lib/ratelimit";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 180;

// POST /api/machine/mpp/orders
//
// MPP create/pay endpoint (literal mirror of PostalForm's orders endpoint).
//   - No payment credential   -> HTTP 402 with WWW-Authenticate challenges and
//                                 { order_id, status: "unpaid" }.
//   - Authorization: Payment  -> HTTP 202 with the settled order + machine.
//
// request_id is the idempotency key: it derives the order id, so resending the
// identical body after a 402 (or replaying a paid call) resolves to the same
// order rather than provisioning a second machine.
export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "checkout");
    if (limited) {
      return limited;
    }

    const payload = await request.clone().json();
    const createRequest = parseCreateMachineRequest(payload, product, { requireRequestId: true });
    const orderId = deriveOrderId(createRequest.requestId!);
    const serviceUrl = serviceUrlFromRequest(request);
    const service = createMachineService();

    // Idempotent replay: a paid order for this request_id already exists. Return
    // its status (without re-issuing management tokens, which were delivered on
    // the original 202) rather than charging or provisioning again.
    const existing = await service.findByOrderId(orderId);
    if (existing) {
      return NextResponse.json(toMppOrder(existing, serviceUrl, { includeMachine: true }), { status: 202 });
    }

    const quote = quoteCheckout(createRequest);
    const checkout = createMppCheckout();
    const payment = await checkout.payment.compose(
      ...checkoutComposeEntries(checkout, quote, createRequest),
    )(request);

    // Unpaid: surface the MPP challenges (WWW-Authenticate) alongside the
    // PostalForm-shaped unpaid order body.
    if (payment.status === 402) {
      const headers = new Headers(payment.challenge.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      return new NextResponse(JSON.stringify({ order_id: orderId, status: "unpaid" }), {
        status: 402,
        headers,
      });
    }

    // Only provision when MPP explicitly confirms a settled payment (status
    // 200). Any other status must not create a machine.
    if (payment.status !== 200) {
      return NextResponse.json({ error: "Payment could not be verified." }, { status: 402 });
    }

    const created = await service.createMachine(createRequest, orderId);
    after(() => service.provisionMachine(created.lease.id));
    return payment.withReceipt(
      NextResponse.json(
        toMppOrder(created.lease, serviceUrl, { management: created.management, includeMachine: true }),
        { status: 202 },
      ),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof CheckoutConfigurationError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    // A payment that fails verification (bad/expired/insufficient credential)
    // must surface as a payment error, never a 500 — and no machine is created.
    if (error instanceof Errors.PaymentError) {
      return NextResponse.json(error.toProblemDetails(), { status: error.status });
    }
    throw error;
  }
}
