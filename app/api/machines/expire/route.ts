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
  return NextResponse.json({ expired, reaped });
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

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}
