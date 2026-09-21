import { getServerConfig, publicConfig } from "@/lib/agent/providers/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(publicConfig(getServerConfig()), {
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
