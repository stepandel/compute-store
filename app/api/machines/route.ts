import { NextResponse } from "next/server";
import { createMachineService } from "@/lib/service";
import { product } from "@/lib/config";
import { toPublicMachine } from "@/lib/models";
import { parseCreateMachineRequest, ValidationError } from "@/lib/validation";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const createRequest = parseCreateMachineRequest(payload, product);
    const lease = await createMachineService().createMachine(createRequest);
    return NextResponse.json(toPublicMachine(lease), { status: 202 });
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

