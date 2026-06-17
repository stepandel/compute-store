import { NextResponse } from "next/server";
import { createMachineService } from "@/lib/service";

export async function POST() {
  const expired = await createMachineService().expireDueMachines();
  return NextResponse.json({ expired });
}

