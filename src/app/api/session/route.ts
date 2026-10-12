// GET /api/session
// Returns the current demo user (if any). The browser sends a demo
// user ID via the `x-demo-user` header or `?user=` query param.
// This is NOT authentication — it is a local demonstration selector.

import { NextResponse, type NextRequest } from "next/server";
import { resolveSession, DEMO_LABEL } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const demoUserId =
    request.headers.get("x-demo-user") ??
    request.nextUrl.searchParams.get("user") ??
    null;

  const { user } = resolveSession(demoUserId);

  return NextResponse.json({
    user,
    isDemo: true,
    label: DEMO_LABEL,
  });
}
