// Mutable working copy of source documents and permissions.
//
// At startup, this module loads the original seed.json dataset into an
// in-memory mutable store. The original seed.json file is NEVER modified.
//
// Operator commands (via /api/demo endpoints) mutate this working copy:
//   - applyE01: replace CONF-ENG-002 with version 2 (runbook update)
//   - applyE02: revoke Daniel's access to CONF-ENG-001 and CONF-ENG-002
//   - resetDemo: reload from seed.json, discarding all changes
//
// All other modules (seed.ts, permissions.ts, retrieval.ts) read from
// this store, so changes take effect immediately on the next query.

import type {
  SeedData,
  SeedDocument,
  SeedUser,
  Acl,
} from "./types";
import seedJson from "../server-data/seed.json";

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

const originalSeedData = seedJson as unknown as SeedData;

// Deep-clone helper: structuredClone is available in Node 18+.
function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

// The working copy — mutable, initialized from seed.json at module load.
let workingData: SeedData = deepClone(originalSeedData);

// Lookup maps over the working copy. Rebuilt on every mutation.
let workingUsers: Map<string, SeedUser> = new Map(
  workingData.users.map((u) => [u.id, deepClone(u)]),
);
let workingDocuments: Map<string, SeedDocument> = new Map(
  workingData.documents.map((d) => [d.id, deepClone(d)]),
);

function rebuildMaps(): void {
  workingUsers = new Map(workingData.users.map((u) => [u.id, deepClone(u)]));
  workingDocuments = new Map(
    workingData.documents.map((d) => [d.id, deepClone(d)]),
  );
}

// ── Read accessors (used by seed.ts) ──────────────────────────────

export function getWorkingData(): SeedData {
  return workingData;
}

export function getWorkingUsers(): SeedUser[] {
  return workingData.users;
}

export function getWorkingDocuments(): SeedDocument[] {
  return workingData.documents;
}

export function getWorkingUserById(id: string): SeedUser | null {
  return workingUsers.get(id) ?? null;
}

export function getWorkingDocumentById(id: string): SeedDocument | null {
  return workingDocuments.get(id) ?? null;
}

// ── Operator: reset demo ──────────────────────────────────────────

export interface DemoStateInfo {
  state: string;
  applied_events: string[];
  source_update_time: string | null;
  ingestion_time: string | null;
  e02_applied: boolean;
}

let demoState: DemoStateInfo = {
  state: "baseline",
  applied_events: [],
  source_update_time: null,
  ingestion_time: null,
  e02_applied: false,
};

export function getDemoState(): DemoStateInfo {
  return { ...demoState };
}

/**
 * Reset the working copy to the original seed.json baseline.
 * Discards all E01/E02 changes.
 */
export function resetDemo(): DemoStateInfo {
  workingData = deepClone(originalSeedData);
  rebuildMaps();
  demoState = {
    state: "baseline",
    applied_events: [],
    source_update_time: null,
    ingestion_time: null,
    e02_applied: false,
  };
  return { ...demoState };
}

// ── Operator: E01 — replace source runbook with version 2 ─────────

export interface E01Result {
  ok: boolean;
  event: "E01";
  document_id: string;
  source_update_time: string;
  ingestion_time: string;
  sync_duration_ms: number;
  state: string;
  // Detailed breakdown of what each timestamp measures:
  //   source_update_time: when the source copy was replaced (simulated).
  //   ingestion_time: when the synchronization process finished making
  //     the updated document retrievable through the normal retrieval
  //     pipeline (re-indexed into the working document store).
  //   sync_duration_ms: elapsed time from source_update_time to
  //     ingestion_time — the synchronization latency. This measures
  //     the in-memory re-indexing step, not the source mutation itself.
  //     In a production system this would include crawl + parse + index
  //     time. Here it is near-zero because the working store is in-memory
  //     and the retrieval pipeline reads from it directly.
  sync_details?: {
    source_mutation: string;
    ingestion: string;
    retrieval_rebuild: string;
  };
  error?: string;
}

/**
 * E01: Replace the source copy of CONF-ENG-002 with version 2.
 *
 * This simulates a source document update in two steps:
 *
 * Step 1 — Source copy change: The source system (simulated) publishes
 *   an updated version of CONF-ENG-002. We record source_update_time.
 *   The new content includes a canary check step (CORRIDOR-CHECK-27)
 *   that was not in version 1.
 *
 * Step 2 — Synchronization / ingestion: The application's sync process
 *   detects the source change and ingests the new version into the
 *   working document store. This is the normal retrieval pipeline —
 *   the retrieval engine reads from the working store on every query,
 *   so the updated document becomes retrievable immediately after
 *   ingestion. We record ingestion_time.
 *
 * The sync_duration_ms measures the time from source_update_time to
 * ingestion_time. In this in-memory implementation it is near-zero
 * (the "retrieval rebuild" is just rebuilding the lookup maps).
 * In a production system this would include crawl + parse + index time.
 *
 * Per demo-events.json: "Do not directly seed the new answer into
 * the search index." We do NOT insert CORRIDOR-CHECK-27 directly
 * into any answer cache. We replace the document content in the
 * working store, and the retrieval engine finds it through its
 * normal keyword-matching pipeline on the next query.
 */
export function applyE01(): E01Result {
  if (demoState.applied_events.includes("E01")) {
    return {
      ok: false,
      event: "E01",
      document_id: "CONF-ENG-002",
      source_update_time: demoState.source_update_time!,
      ingestion_time: demoState.ingestion_time!,
      sync_duration_ms: 0,
      state: demoState.state,
      error: "E01 already applied",
    };
  }

  // Step 1: Source copy change — simulate the source publishing v2.
  const sourceUpdateTime = new Date().toISOString();
  const syncStart = Date.now();

  // The v2 runbook content from demo-events.json
  const v2Content = `# SGD to IDR payout recovery runbook

Fictional hackathon data for Company A. This is not a real incident or a real company record.

Runbook reference: RB-IDR-01. Owner: Payments Engineering.
This is version 2 of the demo runbook.

## Recovery procedure

1. Pause dispatch for the affected corridor and identify the affected payout IDs.
2. Confirm each payout includes a non-empty \`destination_branch_code\` that matches the partner contract.
3. Check the retry idempotency key for each payout. Cancel duplicate queued jobs before replay.
4. Confirm reconciliation status with the incident commander and replay each approved payout once.
5. Compare dispatch and settlement records before returning the corridor to normal operation.
6. Run the canary check \`CORRIDOR-CHECK-27\` and record its result before releasing the next batch.

## Latest revision

On 12 October 2026 at 10:01 Singapore time, the runbook owner added the canary check in step 6.

## Change record

On 20 August, the runbook incorporated the permanent validator from PAY-101 and the retry idempotency guard from PAY-102. The linked Slack sign-off thread records who approved each change. PAY-103 remains a separate monitoring improvement.

This runbook does not contain customer impact figures or regulatory filing decisions.
`;

  // Find the existing document in the working copy
  const existingDoc = workingDocuments.get("CONF-ENG-002");
  if (!existingDoc) {
    return {
      ok: false,
      event: "E01",
      document_id: "CONF-ENG-002",
      source_update_time: sourceUpdateTime,
      ingestion_time: sourceUpdateTime,
      sync_duration_ms: 0,
      state: demoState.state,
      error: "Document CONF-ENG-002 not found in working copy",
    };
  }

  // Create the updated document (v2)
  const updatedDoc: SeedDocument = {
    ...deepClone(existingDoc),
    version: 2,
    updated_at: "2026-10-12T10:01:00+08:00",
    content_markdown: v2Content,
  };

  // Step 2: Synchronization / ingestion — replace the document in the
  // working copy's document store and rebuild the lookup maps.
  const docIndex = workingData.documents.findIndex(
    (d) => d.id === "CONF-ENG-002",
  );
  if (docIndex === -1) {
    return {
      ok: false,
      event: "E01",
      document_id: "CONF-ENG-002",
      source_update_time: sourceUpdateTime,
      ingestion_time: sourceUpdateTime,
      sync_duration_ms: Date.now() - syncStart,
      state: demoState.state,
      error: "Document index not found",
    };
  }

  // Replace in the working data array — this is the ingestion step.
  // The retrieval engine reads from this store on every query, so
  // the updated content becomes retrievable through normal keyword
  // matching immediately after this line.
  (workingData.documents as Mutable<SeedDocument[]>)[docIndex] = updatedDoc;

  // Rebuild the lookup maps — this is the "retrieval rebuild" step.
  // In a production system this would be re-indexing into a search engine.
  // Here it is an in-memory map rebuild.
  rebuildMaps();

  const retrievalRebuildEnd = Date.now();

  // Record the ingestion time on the document
  const ingestionTime = new Date().toISOString();
  updatedDoc.ingested_at = ingestionTime;

  const syncDurationMs = retrievalRebuildEnd - syncStart;

  demoState = {
    state: "after_runbook_update",
    applied_events: [...demoState.applied_events, "E01"],
    source_update_time: sourceUpdateTime,
    ingestion_time: ingestionTime,
    e02_applied: demoState.e02_applied,
  };

  return {
    ok: true,
    event: "E01",
    document_id: "CONF-ENG-002",
    source_update_time: sourceUpdateTime,
    ingestion_time: ingestionTime,
    sync_duration_ms: syncDurationMs,
    state: demoState.state,
    sync_details: {
      source_mutation: sourceUpdateTime,
      ingestion: ingestionTime,
      retrieval_rebuild: `${syncDurationMs}ms (in-memory map rebuild)`,
    },
  };
}

// ── Operator: E02 — revoke Daniel's Confluence ENG access ─────────

export interface E02Result {
  ok: boolean;
  event: "E02";
  affected_document_ids: string[];
  policy_version: number;
  applied_at: string;
  state: string;
  error?: string;
}

/**
 * E02: Revoke Daniel's access to the two engineering Confluence
 * documents (CONF-ENG-001 and CONF-ENG-002).
 *
 * This removes "daniel" from the effective_reader_user_ids of both
 * documents and updates the policy_version to 2.
 *
 * Daniel's Jira, Slack, and general-document access is preserved.
 *
 * The permission change takes effect immediately on the next query
 * because canRead() reads from the working document store.
 */
export function applyE02(): E02Result {
  if (demoState.applied_events.includes("E02")) {
    return {
      ok: false,
      event: "E02",
      affected_document_ids: ["CONF-ENG-001", "CONF-ENG-002"],
      policy_version: 2,
      applied_at: demoState.source_update_time ?? new Date().toISOString(),
      state: demoState.state,
      error: "E02 already applied",
    };
  }

  // E02 requires E01 to have been applied first (per demo-events.json:
  // requires_state: "after_runbook_update")
  if (!demoState.applied_events.includes("E01")) {
    return {
      ok: false,
      event: "E02",
      affected_document_ids: ["CONF-ENG-001", "CONF-ENG-002"],
      policy_version: 2,
      applied_at: new Date().toISOString(),
      state: demoState.state,
      error: "E02 requires state 'after_runbook_update' (apply E01 first)",
    };
  }

  const appliedAt = new Date().toISOString();
  const affectedIds = ["CONF-ENG-001", "CONF-ENG-002"];

  // Update ACLs in the working data
  for (const docId of affectedIds) {
    const docIndex = workingData.documents.findIndex((d) => d.id === docId);
    if (docIndex === -1) continue;

    const doc = workingData.documents[docIndex];
    const newAcl: Acl = {
      policy_version: 2,
      effective_reader_user_ids: [],
      authority: "synthetic_source_fixture",
    };

    const updatedDoc: SeedDocument = {
      ...deepClone(doc),
      acl: newAcl,
      // Update source_scope to remove the engineering group
      source_scope: {
        ...deepClone(doc.source_scope),
        space_reader_group_ids: [],
      },
    };

    (workingData.documents as Mutable<SeedDocument[]>)[docIndex] = updatedDoc;
  }

  rebuildMaps();

  demoState = {
    state: "after_confluence_revocation",
    applied_events: [...demoState.applied_events, "E02"],
    source_update_time: demoState.source_update_time,
    ingestion_time: demoState.ingestion_time,
    e02_applied: true,
  };

  return {
    ok: true,
    event: "E02",
    affected_document_ids: affectedIds,
    policy_version: 2,
    applied_at: appliedAt,
    state: demoState.state,
  };
}
