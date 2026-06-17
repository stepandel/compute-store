import { NextResponse } from "next/server";
import {
  CheckoutConfigurationError,
  checkoutComposeEntries,
  createMppCheckout,
  quoteCheckout,
} from "@/lib/checkout";
import { product } from "@/lib/config";
import { toPublicMachine } from "@/lib/models";
import { createMachineService } from "@/lib/service";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const payload = await request.clone().json();
    const createRequest = parseCreateMachineRequest(payload, product);
    const quote = quoteCheckout(createRequest);

    const checkout = createMppCheckout();
    const payment = await checkout.payment.compose(...checkoutComposeEntries(checkout, quote))(request);

    if (payment.status === 402) {
      return payment.challenge;
    }

    const created = await createMachineService().createMachine(createRequest);
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
    throw error;
  }
}
