import { NextResponse } from "next/server";
import { agentStorefrontManifest } from "@/lib/discovery";

export async function GET(request: Request) {
  return NextResponse.json(agentStorefrontManifest(request), {
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}
