// GET /api/audit
//
// Returns audit events for the authenticated demo user.
// Audit access is restricted: only Priya has audit.read_demo_scope
// for the three demo users. Daniel and Marcus get 403.
//
// Query params:
//   ?target=<userId> — whose audit events to retrieve (defaults to self)

import { NextResponse, type NextRequest } from "next/server";
import { resolveSession } from "@/lib/session";
import { canReadAudit, getAuditLogForUser } from "@/lib/audit";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const demoUserId =
    request.headers.get("x-demo-user") ??
    request.nextUrl.searchParams.get("user") ??
    null;

  const { user } = resolveSession(demoUserId);

  if (!user) {
    return NextResponse.json(
      { error: "No demo session selected." },
      { status: 401 },
    );
  }

  if (!canReadAudit(user.id)) {
    return NextResponse.json(
      { error: "Audit access not available for this demo identity." },
      { status: 403 },
    );
  }

  const targetUserId =
    request.nextUrl.searchParams.get("target") ?? user.id;

  const events = getAuditLogForUser(user.id, targetUserId);

  return NextResponse.json({
    requester: user.id,
    target: targetUserId,
    events,
    count: events.length,
  });
}
