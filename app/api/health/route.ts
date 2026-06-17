import { NextResponse } from "next/server";
import { product } from "@/lib/config";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    product: product.id,
  });
}

