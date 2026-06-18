import { NextResponse, after } from "next/server";
import { Errors } from "mppx";
import {
  assertOperatorSponsoredSandboxCheckoutAllowed,
  CheckoutConfigurationError,
  checkoutComposeEntries,
  createMppCheckout,
  createOperatorSponsoredSandboxCredential,
  quoteCheckout,
} from "@/lib/checkout";
import { product } from "@/lib/config";
import { toPublicMachine } from "@/lib/models";
import { enforceRateLimit } from "@/lib/ratelimit";
import { createMachineService } from "@/lib/service";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "checkout");
    if (limited) {
      return limited;
    }

    assertOperatorSponsoredSandboxCheckoutAllowed();

    const payload = await request.clone().json();
    const createRequest = parseCreateMachineRequest(payload, product);
    const quote = quoteCheckout(createRequest);
    const checkout = createMppCheckout();
    const compose = checkout.payment.compose(...checkoutComposeEntries(checkout, quote));
    const challengePayment = await compose(request);
    if (challengePayment.status !== 402) {
      return NextResponse.json({ error: "Sandbox checkout expected an MPP payment challenge." }, { status: 502 });
    }

    const credential = await createOperatorSponsoredSandboxCredential(challengePayment.challenge);
    const paidRequest = new Request(request.url, {
      method: "POST",
      headers: {
        authorization: credential,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const payment = await compose(paidRequest);
    if (payment.status !== 200) {
      return payment.status === 402
        ? payment.challenge
        : NextResponse.json({ error: "Sandbox payment could not be verified." }, { status: 402 });
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
            sandbox: "operator-sponsored",
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
    if (error instanceof Errors.PaymentError) {
      return NextResponse.json(error.toProblemDetails(), { status: error.status });
    }
    throw error;
  }
}
