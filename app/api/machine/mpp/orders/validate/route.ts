import { NextResponse } from "next/server";
import { enforceRateLimit } from "@/lib/ratelimit";
import { validateOrder } from "@/lib/orders";
import { ValidationError } from "@/lib/validation";

export const runtime = "nodejs";

// POST /api/machine/mpp/orders/validate
//
// Preflight quote/validate step (MPP). The agent POSTs the order it intends to
// buy and receives the protocol, accepted payment methods, and final quote —
// no payment is composed and no machine is created. Reuse the same body
// (notably request_id) on POST /api/machine/mpp/orders.
export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "checkout");
    if (limited) {
      return limited;
    }

    const payload = await request.json();
    return NextResponse.json(validateOrder(payload), { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
