import { NextResponse } from "next/server";
import { toPublicMachine } from "@/lib/models";
import { createMachineService } from "@/lib/service";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const lease = await createMachineService().getMachine(id);
  if (!lease) {
    return NextResponse.json({ error: "Machine not found." }, { status: 404 });
  }
  return NextResponse.json(toPublicMachine(lease));
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  const lease = await createMachineService().terminateMachine(id);
  if (!lease) {
    return NextResponse.json({ error: "Machine not found." }, { status: 404 });
  }
  return NextResponse.json(toPublicMachine(lease));
}

