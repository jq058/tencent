// Server-only mutable working store.
//
// This module holds mutable copies of the seed documents and their
// ACLs. All retrieval, permission checks, and document access go
// through this store (not the static seed directly).
//
// The original seed data is preserved and never mutated. Reset
// restores the working copies to the original seed baseline.
//
// Mutations supported:
//   - updateDocument: replace a document's content + bump version
//     (used by E01: update CONF-ENG-002 to version 2)
//   - revokeAccess: remove a user from a document's ACL
//     (used by E02: revoke Daniel's access to CONF-ENG-001/002)
//   - reset: restore all working copies to the seed baseline
//
// The store is in-memory (sufficient for a local demo).

import seedJson from "../server-data/seed.json";
import type { SeedData, SeedDocument, SeedUser, Acl } from "./types";

const originalSeed = seedJson as unknown as SeedData;

// Deep-clone a document so the working copy can be mutated
// independently of the seed.
function cloneDoc(doc: SeedDocument): SeedDocument {
  return {
    ...doc,
    acl: { ...doc.acl },
    source_scope: { ...doc.source_scope },
    related_document_ids: [...doc.related_document_ids],
  };
}

// Working copies (mutable).
let workingDocuments: SeedDocument[] = originalSeed.documents.map(cloneDoc);
let workingUsers: SeedUser[] = originalSeed.users.map((u) => ({ ...u }));

// Track mutation state for the status endpoint.
interface MutationState {
  updated_documents: { document_id: string; from_version: number; to_version: number; timestamp: string }[];
  revoked_access: { document_id: string; user_id: string; timestamp: string }[];
  reset_count: number;
  last_reset_at: string | null;
}

let mutationState: MutationState = {
  updated_documents: [],
  revoked_access: [],
  reset_count: 0,
  last_reset_at: null,
};

// Build lookup maps (rebuilt on each mutation to stay consistent).
let documentsById = new Map(workingDocuments.map((d) => [d.id, d]));
let usersById = new Map(workingUsers.map((u) => [u.id, u]));

function rebuildMaps(): void {
  documentsById = new Map(workingDocuments.map((d) => [d.id, d]));
  usersById = new Map(workingUsers.map((u) => [u.id, u]));
}

rebuildMaps();

// ── Read accessors (used by permissions.ts, retrieval.ts, seed.ts) ──

export function getWorkingDocuments(): SeedDocument[] {
  return workingDocuments;
}

export function getWorkingUsers(): SeedUser[] {
  return workingUsers;
}

export function getWorkingDocumentById(id: string): SeedDocument | null {
  return documentsById.get(id) ?? null;
}

export function getWorkingUserById(id: string): SeedUser | null {
  return usersById.get(id) ?? null;
}

export function getOriginalSeedData(): SeedData {
  return originalSeed;
}

export function getMutationState(): MutationState {
  return { ...mutationState };
}

// ── E01: Update a document's content and bump its version ──
//
// Replaces the document's content_markdown and title with the new
// values, increments the version, updates the updated_at timestamp,
// and records the mutation in the state log.
//
// Returns the updated document, or null if the document doesn't exist.

export function updateDocument(
  documentId: string,
  newContent: string,
  newTitle?: string,
): { ok: boolean; document?: SeedDocument; error?: string } {
  const doc = documentsById.get(documentId);
  if (!doc) {
    return { ok: false, error: `Document ${documentId} not found.` };
  }

  const oldVersion = doc.version;
  const newVersion = oldVersion + 1;
  const now = new Date().toISOString();

  const updatedDoc: SeedDocument = {
    ...doc,
    content_markdown: newContent,
    title: newTitle ?? doc.title,
    version: newVersion,
    updated_at: now,
  };

  // Replace in working array.
  workingDocuments = workingDocuments.map((d) =>
    d.id === documentId ? updatedDoc : d,
  );
  rebuildMaps();

  mutationState.updated_documents.push({
    document_id: documentId,
    from_version: oldVersion,
    to_version: newVersion,
    timestamp: now,
  });

  return { ok: true, document: updatedDoc };
}

// ── E02: Revoke a user's access to a document ──
//
// Removes the user from the document's acl.effective_reader_user_ids
// and bumps the acl.policy_version. Records the revocation.
//
// Returns the updated document, or null if the document or user
// doesn't exist or the user didn't have access.

export function revokeAccess(
  documentId: string,
  userId: string,
): { ok: boolean; document?: SeedDocument; error?: string } {
  const doc = documentsById.get(documentId);
  if (!doc) {
    return { ok: false, error: `Document ${documentId} not found.` };
  }

  const user = usersById.get(userId);
  if (!user) {
    return { ok: false, error: `User ${userId} not found.` };
  }

  if (!doc.acl.effective_reader_user_ids.includes(userId)) {
    return {
      ok: false,
      error: `User ${userId} does not have access to ${documentId}.`,
    };
  }

  const now = new Date().toISOString();
  const newAcl: Acl = {
    ...doc.acl,
    policy_version: doc.acl.policy_version + 1,
    effective_reader_user_ids: doc.acl.effective_reader_user_ids.filter(
      (id) => id !== userId,
    ),
  };

  const updatedDoc: SeedDocument = {
    ...doc,
    acl: newAcl,
  };

  workingDocuments = workingDocuments.map((d) =>
    d.id === documentId ? updatedDoc : d,
  );
  rebuildMaps();

  mutationState.revoked_access.push({
    document_id: documentId,
    user_id: userId,
    timestamp: now,
  });

  return { ok: true, document: updatedDoc };
}

// ── Reset: restore all working copies to the seed baseline ──
//
// Deep-clones the original seed documents and users again,
// discarding all mutations.

export function reset(): { ok: boolean; message: string } {
  workingDocuments = originalSeed.documents.map(cloneDoc);
  workingUsers = originalSeed.users.map((u) => ({ ...u }));
  rebuildMaps();

  const now = new Date().toISOString();
  mutationState = {
    updated_documents: [],
    revoked_access: [],
    reset_count: mutationState.reset_count + 1,
    last_reset_at: now,
  };

  return {
    ok: true,
    message: "Working store reset to baseline.",
  };
}

// ── Count helpers for verification ──

export function getPermittedCount(userId: string): number {
  return workingDocuments.filter((d) =>
    d.acl.effective_reader_user_ids.includes(userId),
  ).length;
}

// ── E01 specific: update CONF-ENG-002 to version 2 ──
//
// The new runbook adds CORRIDOR-CHECK-27 and requires recording the
// result before releasing the next batch.

const E01_NEW_RUNBOOK_CONTENT = `# SGD to IDR payout recovery runbook

Fictional hackathon data for Company A. This is not a real incident or a real company record.

Runbook reference: RB-IDR-01. Owner: Payments Engineering.
This is version 2 of the demo runbook.

## Recovery procedure

1. Pause dispatch for the affected corridor and identify the affected payout IDs.
2. Confirm each payout includes a non-empty \`destination_branch_code\` that matches the partner contract.
3. Check the retry idempotency key for each payout. Cancel duplicate queued jobs before replay.
4. Run the canary check **CORRIDOR-CHECK-27** and record the result before releasing the next batch.
5. Confirm reconciliation status with the incident commander and replay each approved payout once.
6. Compare dispatch and settlement records before returning the corridor to normal operation.

## Change record

On 20 August, the runbook incorporated the permanent validator from PAY-101 and the retry idempotency guard from PAY-102. The linked Slack sign-off thread records who approved each change. PAY-103 remains a separate monitoring improvement.

This runbook does not contain customer impact figures or regulatory filing decisions.
`;

export function applyE01(): { ok: boolean; document?: SeedDocument; error?: string } {
  return updateDocument("CONF-ENG-002", E01_NEW_RUNBOOK_CONTENT);
}

// ── E02 specific: revoke Daniel's access to CONF-ENG-001 and CONF-ENG-002 ──

export function applyE02(): { ok: boolean; results: { document_id: string; ok: boolean; error?: string }[] } {
  const results: { document_id: string; ok: boolean; error?: string }[] = [];

  const r1 = revokeAccess("CONF-ENG-001", "daniel");
  results.push({
    document_id: "CONF-ENG-001",
    ok: r1.ok,
    error: r1.error,
  });

  const r2 = revokeAccess("CONF-ENG-002", "daniel");
  results.push({
    document_id: "CONF-ENG-002",
    ok: r2.ok,
    error: r2.error,
  });

  return { ok: results.every((r) => r.ok), results };
}
