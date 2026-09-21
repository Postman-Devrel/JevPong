import { createDecisionHandler } from "@/lib/agent/providers/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createDecisionHandler();
