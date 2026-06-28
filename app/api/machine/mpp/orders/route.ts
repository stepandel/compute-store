import { NextResponse, after } from "next/server";
import { Errors } from "mppx";
import {
  CheckoutConfigurationError,
  checkoutComposeEntries,
  createMppCheckout,
  quoteCheckout,
} from "@/lib/checkout";
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
    const createRequest = parseCreateMachineRequest(payload, { requireRequestId: true });
    const orderId = deriveOrderId(createRequest.requestId!);
    const serviceUrl = serviceUrlFromRequest(request);
    const service = createMachineService(createRequest.productId);

    const log = (event: string, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ event, order_id: orderId, request_id: createRequest.requestId, ...extra }));

    // Idempotent replay: a paid order for this request_id already exists. Return
    // its status (without re-issuing management tokens, which were delivered on
    // the original 202) rather than charging or provisioning again.
    const existing = await service.findByOrderId(orderId);
    if (existing) {
      log("mpp_order_replay", { machine_id: existing.id });
      return NextResponse.json(toMppOrder(existing, serviceUrl, { includeMachine: true }), { status: 202 });
    }

    const quote = quoteCheckout(createRequest);
    const checkout = createMppCheckout();

    // onPaymentFailed fires ONLY when a credential was submitted and rejected
    // (bad/expired SPT, challenge not issued by us, Stripe declined, ...). It is
    // the signal that distinguishes "no credential attached" from "credential
    // attached but rejected" — the exact ambiguity behind a paid retry that
    // unexpectedly comes back 402. Captured here, logged and surfaced below.
    let credentialRejection: string | undefined;
    checkout.payment.onPaymentFailed((ctx) => {
      credentialRejection = ctx.error?.message ?? "Payment credential was rejected.";
    });

    // Whether the inbound request even carried an MPP credential. If a retry
    // arrives without this, the Authorization header never reached the function
    // (edge/transport/client), not a verification failure.
    const credentialPresent = /^payment\b/i.test(request.headers.get("authorization") ?? "");
    const payment = await checkout.payment.compose(
      ...checkoutComposeEntries(checkout, quote, createRequest),
    )(request);

    // Unpaid: surface the MPP challenges (WWW-Authenticate) alongside the
    // PostalForm-shaped unpaid order body.
    if (payment.status === 402) {
      // Logged to the platform (Vercel) runtime logs so this is diagnosable
      // without a side-channel proxy next time a paid retry re-challenges.
      log("mpp_order_unpaid", { credential_present: credentialPresent, rejection: credentialRejection ?? null });
      const headers = new Headers(payment.challenge.headers);
      headers.set("content-type", "application/json");
      headers.delete("content-length");
      const body: Record<string, unknown> = { order_id: orderId, status: "unpaid" };
      if (credentialPresent) {
        // A credential WAS attached but not accepted — tell the client so it
        // doesn't misread this as the plain no-credential challenge and can act
        // on the reason (e.g. SPT not yet ready -> back off and retry).
        body.credential_status = "rejected";
        body.reason = credentialRejection ?? "Payment credential was not accepted.";
      }
      return new NextResponse(JSON.stringify(body), { status: 402, headers });
    }

    // Only provision when MPP explicitly confirms a settled payment (status
    // 200). Any other status must not create a machine.
    if (payment.status !== 200) {
      log("mpp_order_unverified");
      return NextResponse.json({ error: "Payment could not be verified." }, { status: 402 });
    }

    const created = await service.createMachine(createRequest, orderId);
    after(() => service.provisionMachine(created.lease.id));
    log("mpp_order_settled", { machine_id: created.lease.id });
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
