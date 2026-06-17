import { NextResponse } from "next/server";
import { toPublicMachine } from "@/lib/models";
import { AuthorizationError, createMachineService } from "@/lib/service";
import { enforceRateLimit } from "@/lib/ratelimit";
import { parseExtendMachineRequest, ValidationError } from "@/lib/validation";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const limited = await enforceRateLimit(request, "manage");
    if (limited) {
      return limited;
    }
    const additionalMinutes = parseExtendMachineRequest(await request.json());
    const lease = await createMachineService().extendMachine(id, bearerToken(request), additionalMinutes);
    if (!lease) {
      return NextResponse.json({ error: "Machine not found." }, { status: 404 });
    }
    return NextResponse.json(toPublicMachine(lease));
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    if (error instanceof ValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}
