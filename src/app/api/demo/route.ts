// GET  /api/demo        — status: current working store state
// POST /api/demo        — operator mutations (reset, update, revoke)
//
// POST mutations require a private DEMO_OPERATOR_SECRET header
// (x-demo-operator-secret). GET is unrestricted (read-only status).
//
// Actions:
//   { action: "status" }     — same as GET, returns working store state
//   { action: "reset" }     — restore baseline
//   { action: "e01" }       — update CONF-ENG-002 to version 2
//   { action: "e02" }       — revoke Daniel's access to CONF-ENG-001/002
//   { action: "update", document_id, content, title? }  — custom update
//   { action: "revoke", document_id, user_id }           — custom revoke
//
// All mutations return the updated state and document counts.

import { NextResponse, type NextRequest } from "next/server";
import {
  getWorkingDocuments,
  getMutationState,
  getPermittedCount,
  reset,
  applyE01,
  applyE02,
  updateDocument,
  revokeAccess,
} from "@/lib/workstore";

export const dynamic = "force-dynamic";

const BASELINE_COUNTS: Record<string, number> = {
  daniel: 9,
  priya: 5,
  marcus: 2,
};

function getOperatorSecret(): string | undefined {
  return process.env.DEMO_OPERATOR_SECRET;
}

function checkSecret(request: NextRequest): { ok: boolean; error?: string } {
  const secret = getOperatorSecret();
  if (!secret) {
    return {
      ok: false,
      error:
        "DEMO_OPERATOR_SECRET is not configured. Set it in .env.local to use operator mutations.",
    };
  }
  const provided = request.headers.get("x-demo-operator-secret");
  if (!provided || provided !== secret) {
    return { ok: false, error: "Invalid or missing operator secret." };
  }
  return { ok: true };
}

function buildStatusResponse() {
  const docs = getWorkingDocuments();
  const state = getMutationState();
  const counts: Record<string, number> = {};
  for (const userId of Object.keys(BASELINE_COUNTS)) {
    counts[userId] = getPermittedCount(userId);
  }

  return {
    document_count: docs.length,
    user_counts: counts,
    baseline_counts: BASELINE_COUNTS,
    is_at_baseline:
      state.updated_documents.length === 0 &&
      state.revoked_access.length === 0,
    mutations: state,
    documents: docs.map((d) => ({
      id: d.id,
      title: d.title,
      version: d.version,
      updated_at: d.updated_at,
      acl_policy_version: d.acl.policy_version,
      reader_count: d.acl.effective_reader_user_ids.length,
      readers: d.acl.effective_reader_user_ids,
    })),
  };
}

export async function GET() {
  return NextResponse.json(buildStatusResponse());
}

export async function POST(request: NextRequest) {
  // Parse the action.
  let body: { action?: string; document_id?: string; content?: string; title?: string; user_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const action = body.action;
  if (!action) {
    return NextResponse.json(
      { error: "Action is required." },
      { status: 400 },
    );
  }

  // "status" doesn't require a secret (read-only).
  if (action === "status") {
    return NextResponse.json(buildStatusResponse());
  }

  // All other actions require the operator secret.
  const authResult = checkSecret(request);
  if (!authResult.ok) {
    return NextResponse.json(
      { error: authResult.error },
      { status: 403 },
    );
  }

  switch (action) {
    case "reset": {
      reset();
      return NextResponse.json({
        ok: true,
        message: "Working store reset to baseline.",
        ...buildStatusResponse(),
      });
    }

    case "e01": {
      const result = applyE01();
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error },
          { status: 400 },
        );
      }
      return NextResponse.json({
        ok: true,
        message: "E01 applied: CONF-ENG-002 updated to version 2.",
        updated_document: {
          id: result.document!.id,
          version: result.document!.version,
          updated_at: result.document!.updated_at,
        },
        ...buildStatusResponse(),
      });
    }

    case "e02": {
      const result = applyE02();
      return NextResponse.json({
        ok: result.ok,
        message: result.ok
          ? "E02 applied: Daniel's access to CONF-ENG-001 and CONF-ENG-002 revoked."
          : "E02 partially applied — check results.",
        revoke_results: result.results,
        ...buildStatusResponse(),
      });
    }

    case "update": {
      if (!body.document_id || !body.content) {
        return NextResponse.json(
          { error: "document_id and content are required for update." },
          { status: 400 },
        );
      }
      const result = updateDocument(
        body.document_id,
        body.content,
        body.title,
      );
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error },
          { status: 400 },
        );
      }
      return NextResponse.json({
        ok: true,
        message: `Document ${body.document_id} updated.`,
        updated_document: {
          id: result.document!.id,
          version: result.document!.version,
          updated_at: result.document!.updated_at,
        },
        ...buildStatusResponse(),
      });
    }

    case "revoke": {
      if (!body.document_id || !body.user_id) {
        return NextResponse.json(
          { error: "document_id and user_id are required for revoke." },
          { status: 400 },
        );
      }
      const result = revokeAccess(body.document_id, body.user_id);
      if (!result.ok) {
        return NextResponse.json(
          { error: result.error },
          { status: 400 },
        );
      }
      return NextResponse.json({
        ok: true,
        message: `Access to ${body.document_id} revoked for ${body.user_id}.`,
        updated_document: {
          id: result.document!.id,
          acl_policy_version: result.document!.acl.policy_version,
          readers: result.document!.acl.effective_reader_user_ids,
        },
        ...buildStatusResponse(),
      });
    }

    default:
      return NextResponse.json(
        { error: `Unknown action: ${action}` },
        { status: 400 },
      );
  }
}
