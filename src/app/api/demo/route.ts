// Operator API for demo event control.
//
// Endpoints:
//   GET  /api/demo              — current demo state (read-only, no secret)
//   POST /api/demo?action=reset — reset to baseline (requires operator secret)
//   POST /api/demo?action=apply-e01 — update runbook to v2 (requires operator secret)
//   POST /api/demo?action=apply-e02 — revoke Daniel's ENG Confluence access (requires operator secret)
//
// These are local operator commands, NOT triggered through chat messages
// or special question prefixes. They are for demo replay control only.
//
// Security: POST mutations require an operator shared secret
// (DEMO_OPERATOR_SECRET). This must be explicitly configured server-side
// in .env.local. There is NO default value. If the secret is absent,
// all mutation endpoints are disabled (403). Ordinary demo users
// (daniel, priya, marcus) cannot invoke mutations because the secret is
// never exposed to the browser. The GET status endpoint is read-only
// and does not require a secret.

import { NextResponse, type NextRequest } from "next/server";
import {
  getDemoState,
  resetDemo,
  applyE01,
  applyE02,
} from "@/lib/workstore";

export const dynamic = "force-dynamic";

// The operator secret. Must be explicitly set via DEMO_OPERATOR_SECRET
// in the server environment. There is NO default — if absent, all
// mutations are disabled.
const OPERATOR_SECRET = process.env.DEMO_OPERATOR_SECRET ?? null;

function checkOperatorAuth(request: NextRequest): boolean {
  if (!OPERATOR_SECRET) return false;
  const provided =
    request.headers.get("x-operator-secret") ??
    request.nextUrl.searchParams.get("secret") ??
    null;
  if (!provided) return false;
  return provided === OPERATOR_SECRET;
}

export function GET() {
  // Read-only status — no secret required.
  return NextResponse.json(getDemoState());
}

export async function POST(request: NextRequest) {
  // Mutations require the operator secret. If the secret is not
  // configured server-side, all mutations are disabled.
  if (!OPERATOR_SECRET) {
    return NextResponse.json(
      {
        error:
          "Operator mutations are disabled. Set DEMO_OPERATOR_SECRET in .env.local (server-side) to enable.",
      },
      { status: 403 },
    );
  }

  if (!checkOperatorAuth(request)) {
    return NextResponse.json(
      {
        error:
          "Operator secret required. Set the x-operator-secret header or ?secret= query parameter.",
      },
      { status: 403 },
    );
  }

  const action = request.nextUrl.searchParams.get("action");

  switch (action) {
    case "reset":
      return NextResponse.json(resetDemo());

    case "apply-e01": {
      return NextResponse.json(applyE01());
    }

    case "apply-e02": {
      return NextResponse.json(applyE02());
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}. Use reset, apply-e01, or apply-e02.` },
        { status: 400 },
      );
  }
}
