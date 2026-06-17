import { NextResponse } from "next/server";
import { toPublicMachine } from "@/lib/models";
import { AuthorizationError, createMachineService } from "@/lib/service";
import { enforceRateLimit } from "@/lib/ratelimit";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const limited = await enforceRateLimit(request, "read");
    if (limited) {
      return limited;
    }
    const lease = await createMachineService().getMachine(id, bearerToken(request));
    if (!lease) {
      return NextResponse.json({ error: "Machine not found." }, { status: 404 });
    }
    return NextResponse.json(toPublicMachine(lease));
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    throw error;
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const limited = await enforceRateLimit(request, "manage");
    if (limited) {
      return limited;
    }
    const lease = await createMachineService().terminateMachine(id, bearerToken(request));
    if (!lease) {
      return NextResponse.json({ error: "Machine not found." }, { status: 404 });
    }
    return NextResponse.json(toPublicMachine(lease));
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: error.message }, { status: error.statusCode });
    }
    throw error;
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7) : "";
}
