import { NextResponse } from "next/server";
import { serviceUrlFromRequest } from "@/lib/orders";
import { toMppOrder } from "@/lib/models";
import { createMachineService } from "@/lib/service";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

// GET /api/machine/mpp/orders/:id
//
// Poll order/payment status (MPP). Keyed by the order id, which is derived from
// the buyer's unguessable request_id. Returns only non-sensitive order-level
// status (payment_status, current_step, order_complete_url) — never management
// tokens or connection details, which remain behind the capability-token
// machine read at /api/machines/{machine_id}.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const limited = await enforceRateLimit(request, "read");
  if (limited) {
    return limited;
  }

  const { id } = await context.params;
  const service = createMachineService();
  const lease = await service.findByOrderId(id);

  // We persist a lease only after payment settles, so an unknown id is an order
  // that was never paid (or never existed). 404 rather than implying it is a
  // valid unpaid order we are tracking.
  if (!lease) {
    return NextResponse.json({ error: "Order not found." }, { status: 404 });
  }

  return NextResponse.json(toMppOrder(lease, serviceUrlFromRequest(request)), { status: 200 });
}
