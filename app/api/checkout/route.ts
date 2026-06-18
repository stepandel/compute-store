import { NextResponse, after } from "next/server";
import { Errors } from "mppx";
import {
  CheckoutConfigurationError,
  checkoutComposeEntries,
  createMppCheckout,
  quoteCheckout,
} from "@/lib/checkout";
import { product } from "@/lib/config";
import { toPublicMachine } from "@/lib/models";
import { createMachineService } from "@/lib/service";
import { enforceRateLimit } from "@/lib/ratelimit";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "checkout");
    if (limited) {
      return limited;
    }

    const payload = await request.clone().json();
    const createRequest = parseCreateMachineRequest(payload, product);
    const quote = quoteCheckout(createRequest);

    const checkout = createMppCheckout();
    const payment = await checkout.payment.compose(...checkoutComposeEntries(checkout, quote))(request);

    // Only provision when MPP explicitly confirms a settled payment (status
    // 200). Any other outcome (402 challenge, or an unexpected status) must
    // return without creating a machine so we never hand out compute for free.
    if (payment.status !== 200) {
      return payment.status === 402
        ? payment.challenge
        : NextResponse.json({ error: "Payment could not be verified." }, { status: 402 });
    }

    const service = createMachineService();
    const created = await service.createMachine(createRequest);
    after(() => service.provisionMachine(created.lease.id));
    return payment.withReceipt(
      NextResponse.json(
        {
          checkout: {
            status: "paid",
            mode: "mpp",
            quote,
          },
          machine: toPublicMachine(created.lease, created.management),
        },
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
    // must surface as a payment error, never a 500 that hides the cause — and
    // crucially, no machine is created on this path.
    if (error instanceof Errors.PaymentError) {
      return NextResponse.json(error.toProblemDetails(), { status: error.status });
    }
    throw error;
  }
}
