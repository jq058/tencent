// GET /api/documents
// Returns the list of documents permitted for the current demo user.
// Permission filtering is server-side. The browser receives only
// metadata (id, platform, title, version, updated_at) for documents
// the user is allowed to read.

import { NextResponse, type NextRequest } from "next/server";
import { resolveSession } from "@/lib/session";
import { getPermittedDocumentList } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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

  const documents = getPermittedDocumentList(user.id);

  return NextResponse.json({
    user_id: user.id,
    documents,
    count: documents.length,
  });
}
