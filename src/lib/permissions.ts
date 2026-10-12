// Server-only permission engine.
//
// All authorization decisions flow through this module. The browser
// never supplies roles, user IDs, or document permissions — it only
// sends a demo session token. The server resolves the identity and
// checks the ACL for every request.
//
// The ACL is an explicit allowlist: `acl.effective_reader_user_ids`.
// Unknown users and missing grants are denied by default.

import { getUserById, getDocumentById, getSeedDocuments } from "./seed";
import type {
  ClientDocumentMeta,
  ClientDocumentDetail,
  SeedDocument,
} from "./types";

/**
 * Returns true if `userId` is allowed to read `documentId`.
 * Permission is checked against the document's `acl.effective_reader_user_ids`
 * allowlist. Unknown users or missing grants are denied.
 */
export function canRead(userId: string | null, documentId: string): boolean {
  if (!userId) return false;

  const user = getUserById(userId);
  if (!user) return false;

  const doc = getDocumentById(documentId);
  if (!doc) return false;

  return doc.acl.effective_reader_user_ids.includes(userId);
}

/**
 * Returns the list of documents the user is permitted to read.
 * ACLs are checked server-side; the browser receives only permitted metadata.
 */
export function getPermittedDocumentList(
  userId: string | null,
): ClientDocumentMeta[] {
  if (!userId) return [];

  const user = getUserById(userId);
  if (!user) return [];

  return getSeedDocuments()
    .filter((doc) => doc.acl.effective_reader_user_ids.includes(userId))
    .map(stripToMeta);
}

/**
 * Returns a single document if the user is permitted, otherwise null.
 * This is used by the individual-document endpoint and checks
 * permissions independently of the list endpoint.
 */
export function getPermittedDocument(
  userId: string | null,
  documentId: string,
): ClientDocumentDetail | null {
  if (!canRead(userId, documentId)) return null;

  const doc = getDocumentById(documentId);
  if (!doc) return null;

  // Filter related_document_ids by current access before exposing them.
  const visibleRelated = doc.related_document_ids.filter((relatedId) =>
    canRead(userId, relatedId),
  );

  return {
    id: doc.id,
    platform: doc.platform,
    title: doc.title,
    source_url: doc.source_url,
    version: doc.version,
    updated_at: doc.updated_at,
    content_markdown: doc.content_markdown,
    related_document_ids: visibleRelated,
  };
}

function stripToMeta(doc: SeedDocument): ClientDocumentMeta {
  return {
    id: doc.id,
    platform: doc.platform,
    title: doc.title,
    version: doc.version,
    updated_at: doc.updated_at,
  };
}
