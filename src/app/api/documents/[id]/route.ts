// GET /api/documents/[id]
// Returns a single document if the current demo user is permitted.
// Permission is checked independently here — even if the user knows a
// document ID, they only receive content if the ACL allows it.

import { NextResponse, type NextRequest } from "next/server";
import { resolveSession } from "@/lib/session";
import { getPermittedDocument } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const demoUserId =
    request.headers.get("x-demo-user") ??
    request.nextUrl.searchParams.get("user") ??
    null;

  const { user } = resolveSession(demoUserId);

  if (!user) {
    return NextResponse.json(
      { error: "No demo session selected. Use the demo user selector." },
      { status: 401 },
    );
  }

  const document = getPermittedDocument(user.id, id);

  if (!document) {
    // Return the same 404 for both "denied" and "nonexistent" so that
    // the response does not leak whether a restricted document exists.
    return NextResponse.json(
      { error: "Document not found or not available to you." },
      { status: 404 },
    );
  }

  return NextResponse.json(document);
}
