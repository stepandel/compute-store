import { llmsText } from "@/lib/discovery";

export async function GET(request: Request) {
  return new Response(llmsText(request), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
