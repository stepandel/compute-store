import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createMachineService } from "@/lib/service";

export async function GET(request: Request) {
  const unauthorized = authorizeCron(request);
  if (unauthorized) {
    return unauthorized;
  }

  const service = createMachineService();
  const expired = await service.expireDueMachines();
  const reaped = await service.reapStuckProvisioning();
  const pruned = await service.pruneRetiredMachines();
  return NextResponse.json({ expired, reaped, pruned });
}

export async function POST(request: Request) {
  return GET(request);
}

function authorizeCron(request: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET;

  if (!secret && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "CRON_SECRET is required in production." }, { status: 401 });
  }

  if (!secret) {
    return null;
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (!constantTimeEqual(authHeader, `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
