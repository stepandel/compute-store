import { NextResponse } from "next/server";
import { agentStorefrontManifest } from "@/lib/discovery";

export async function GET() {
  return NextResponse.json(agentStorefrontManifest(), {
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}

