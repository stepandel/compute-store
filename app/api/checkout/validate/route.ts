import { NextResponse } from "next/server";
import { checkoutMethods, quoteCheckout } from "@/lib/checkout";
import { product } from "@/lib/config";
import { enforceRateLimit } from "@/lib/ratelimit";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export const runtime = "nodejs";

// Preflight quote/validate step. An agent POSTs the order it intends to buy and
// gets back the protocol, accepted payment methods, and final quote — with no
// payment composed and no machine created. This lets the agent confirm price
// and methods before entering the 402 challenge dance on POST /api/checkout.
//
// Reuse the same request body (notably request_id) on the subsequent checkout:
// the payment challenge is bound to the canonical order, so an identical body
// reproduces the same challenge on the paid retry.
export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "checkout");
    if (limited) {
      return limited;
    }

    const payload = await request.json();
    const createRequest = parseCreateMachineRequest(payload, product);
    const quote = quoteCheckout(createRequest);

    return NextResponse.json(
      {
        protocol: "mpp",
        valid: true,
        methods: checkoutMethods(),
        quote,
        checkout_path: "/api/checkout",
        ...(createRequest.requestId !== undefined ? { request_id: createRequest.requestId } : {}),
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ valid: false, error: error.message }, { status: 400 });
    }
    throw error;
  }
}
