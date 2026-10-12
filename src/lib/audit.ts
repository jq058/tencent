// Server-only audit logger.
//
// Records server-side audit events for each /api/ask request.
// Audit data is server-only and not exposed to ordinary users.
// Priya has audit.read_demo_scope for the three demo users; Daniel
// and Marcus do not have audit access.

import { getUserById } from "./seed";
import type { RetrievedExcerpt } from "./retrieval";

export interface AuditDocumentDecision {
  document_id: string;
  source_version: number;
  policy_version: number;
  decision: "allow" | "deny" | "not_relevant";
  reason: string;
}

export interface AuditEvent {
  request_id: string;
  user_id: string;
  query: string;
  timestamp: string; // ISO 8601
  evaluated_document_decisions: AuditDocumentDecision[];
  model_context_document_ids: string[]; // docs sent to the model
  model_context_document_versions: Record<string, number>;
  final_answer: string;
  citations: string[]; // validated citation IDs
  flags: string[];
}

// In-memory store (sufficient for local demo; a production system
// would use persistent, tamper-evident storage).
const auditLog: AuditEvent[] = [];

export function recordAuditEvent(event: AuditEvent): void {
  auditLog.push(event);
}

export function getAuditLogForUser(
  requesterId: string | null,
  targetUserId: string,
): AuditEvent[] {
  if (!canReadAudit(requesterId)) return [];
  return auditLog.filter((e) => e.user_id === targetUserId);
}

export function canReadAudit(userId: string | null): boolean {
  if (!userId) return false;
  const user = getUserById(userId);
  if (!user) return false;
  return user.application_capabilities.includes("audit.read_demo_scope");
}

export function buildDocumentDecisions(
  evaluatedIds: string[],
  permittedIds: string[],
  modelContextIds: string[],
  excerpts: RetrievedExcerpt[],
): AuditDocumentDecision[] {
  const modelContextSet = new Set(modelContextIds);

  const decisions: AuditDocumentDecision[] = [];

  for (const docId of evaluatedIds) {
    const isPermitted = permittedIds.includes(docId);
    const inModelContext = modelContextSet.has(docId);

    if (inModelContext) {
      const excerpt = excerpts.find((e) => e.document_id === docId);
      decisions.push({
        document_id: docId,
        source_version: excerpt?.document_version ?? 0,
        policy_version: 1,
        decision: "allow",
        reason:
          "Permitted and relevant to query; excerpt sent to model context.",
      });
    } else if (isPermitted) {
      decisions.push({
        document_id: docId,
        source_version: 0,
        policy_version: 1,
        decision: "not_relevant",
        reason: "Permitted but not relevant to query; not sent to model.",
      });
    } else {
      decisions.push({
        document_id: docId,
        source_version: 0,
        policy_version: 1,
        decision: "deny",
        reason: "Not permitted for this user.",
      });
    }
  }

  return decisions;
}

// Detect prompt injection / instruction override attempts.
export function detectFlags(query: string): string[] {
  const flags: string[] = [];
  const lower = query.toLowerCase();

  if (
    lower.includes("ignore your previous instructions") ||
    lower.includes("ignore previous instructions") ||
    lower.includes("ignore your instructions") ||
    lower.includes("you are now in admin mode") ||
    lower.includes("ignore all instructions") ||
    lower.includes("disregard all")
  ) {
    flags.push("explicit_instruction_override");
  }

  // Impersonation attempt: "I am <name>" or "I'm <name>"
  const impersonationMatch = query.match(
    /\b(i am|i'm|my name is|i am called)\s+(\w+)/i,
  );
  if (impersonationMatch) {
    flags.push("possible_impersonation_attempt");
  }

  return flags;
}
