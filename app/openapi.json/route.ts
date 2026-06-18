import { NextResponse } from "next/server";
import { openApiDocument } from "@/lib/discovery";

export async function GET(request: Request) {
  return NextResponse.json(openApiDocument(request), {
    headers: {
      "cache-control": "public, max-age=300",
    },
  });
}
