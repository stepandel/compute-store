import { NextResponse, after } from "next/server";
import { createMachineService } from "@/lib/service";
import { loadSettings } from "@/lib/config";
import { toPublicMachine } from "@/lib/models";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";
import { enforceRateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const maxDuration = 180;

export async function POST(request: Request) {
  try {
    const limited = await enforceRateLimit(request, "create");
    if (limited) {
      return limited;
    }

    if (!loadSettings().allowUnpaidMachineCreate) {
      return NextResponse.json(
        { error: "Unpaid machine creation is disabled. Use POST /api/machine/mpp/orders." },
        { status: 403 },
      );
    }

    const payload = await request.json();
    const createRequest = parseCreateMachineRequest(payload);
    const service = createMachineService(createRequest.productId);
    const created = await service.createMachine(createRequest);
    after(() => service.provisionMachine(created.lease.id));
    return NextResponse.json(toPublicMachine(created.lease, created.management), { status: 202 });
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
