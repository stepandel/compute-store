import { NextResponse } from "next/server";
import { openApiDocument } from "@/lib/discovery";

export async function GET() {
  return NextResponse.json(openApiDocument(), {
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}

