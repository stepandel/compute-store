import { acceptableUseMarkdown } from "@/lib/policy";

export async function GET() {
  return new Response(acceptableUseMarkdown, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/markdown; charset=utf-8",
    },
  });
}
