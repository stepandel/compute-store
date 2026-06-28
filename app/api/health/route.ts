import { NextResponse } from "next/server";
import { PRODUCT_IDS } from "@/lib/config";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    products: PRODUCT_IDS,
  });
}
