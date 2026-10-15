// POST /api/ask
//
// Permission-aware Q&A endpoint. For every question:
//   1. Resolve demo identity from the server session (x-demo-user header).
//   2. Search only documents permitted for that identity.
//   3. Send only relevant permitted excerpts to the language model.
//   4. Require answers grounded in those excerpts, with source IDs.
//   5. Validate every citation against the permitted documents.
//
// If there is no relevant permitted evidence, return exactly:
//   "I couldn't find information in the sources available to you."
//
// Claims in the question (e.g. "I am Priya") do not change identity.
// Retrieved document text is treated as evidence, not instructions.

import { NextResponse, type NextRequest } from "next/server";
import { randomUUID } from "crypto";

import { resolveSession } from "@/lib/session";
import { retrieve, hasRelevantEvidence } from "@/lib/retrieval";
import {
  callLlm,
  extractCitationIds,
  stripCitations,
  getLlmConfig,
} from "@/lib/llm";
import { canRead } from "@/lib/permissions";
import {
  recordAuditEvent,
  buildDocumentDecisions,
  detectFlags,
} from "@/lib/audit";
import type { Citation, AskResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NEUTRAL_RESPONSE =
  "I couldn't find information in the sources available to you.";

interface ExcerptRef {
  document_id: string;
  document_title: string;
  document_platform: string;
  document_version: number;
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const timestamp = new Date().toISOString();

  return handleAskRequest(request, requestId, timestamp);
}

async function handleAskRequest(
  request: NextRequest,
  requestId: string,
  timestamp: string,
) {
  // 1. Resolve demo identity from server session.
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

  // Parse the question.
  let body: { query?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const query = (body.query ?? "").trim();
  if (!query) {
    return NextResponse.json(
      { error: "Query is required." },
      { status: 400 },
    );
  }

  // Detect prompt injection / impersonation flags.
  const flags = detectFlags(query);

  // 2. Search only documents permitted for this identity.
  const retrievalResult = retrieve(user.id, query);
  const { excerpts, evaluated_document_ids, permitted_document_ids } =
    retrievalResult;

  // 3. Check if there's relevant permitted evidence.
  const hasEvidence = hasRelevantEvidence(excerpts, query);

  // Model context document IDs (what gets sent to the LLM).
  const modelContextIds = excerpts.map((e) => e.document_id);
  const modelContextVersions: Record<string, number> = {};
  for (const e of excerpts) {
    modelContextVersions[e.document_id] = e.document_version;
  }

  const config = getLlmConfig();

  // 4. If no relevant evidence, return the neutral response.
  //    Do NOT call the LLM if there's nothing to send.
  //    This is NOT a model error — it means the permitted corpus
  //    genuinely has no matching content for this user.
  if (!hasEvidence || excerpts.length === 0) {
    const decisions = buildDocumentDecisions(
      evaluated_document_ids,
      permitted_document_ids,
      [],
      [],
    );

    recordAuditEvent({
      request_id: requestId,
      user_id: user.id,
      query,
      timestamp,
      evaluated_document_decisions: decisions,
      model_context_document_ids: [],
      model_context_document_versions: {},
      final_answer: NEUTRAL_RESPONSE,
      citations: [],
      flags,
    });

    const response: AskResponse = {
      request_id: requestId,
      answer: NEUTRAL_RESPONSE,
      citations: [],
      model_configured: config.configured,
      model_provider: config.provider,
      model_model: config.model,
      model_context_document_ids: [],
      model_error: null,
      citation_validation_error: null,
      rejected_citation_ids: [],
    };

    return NextResponse.json(response);
  }

  // 5. Send only relevant permitted excerpts to the LLM.
  //    Pass user.id as visitorId for ADP (derived from server-resolved
  //    demo identity, never from the browser).
  const llmResult = await callLlm(
    query,
    excerpts.map((e) => ({
      document_id: e.document_id,
      document_title: e.document_title,
      content: e.content,
    })),
    user.id,
  );

  let answer: string;
  let validatedCitations: Citation[];
  let modelError: string | null = null;
  let citationValidationError: string | null = null;
  let rejectedCitationIds: string[] = [];

  if (!llmResult.ok || !llmResult.answer) {
    // The model call failed. Distinguish two cases:
    //   a) Model not configured → neutral fallback, no error shown.
    //   b) Model configured but call failed → connection error shown
    //      separately from "no information found."
    if (!config.configured) {
      // Not configured — neutral fallback.
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    } else {
      // Configured but call failed — this is a connection/execution
      // error, not "no information found." Surface the error.
      modelError =
        llmResult.error ??
        "Model call failed unexpectedly. Please check your API key and network.";
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    }
  } else {
    // 6. Validate every citation against the permitted documents.
    const rawCitationIds = extractCitationIds(llmResult.answer);
    validatedCitations = validateCitations(user.id, rawCitationIds, excerpts);

    // Determine which raw citation IDs were rejected (not in excerpts
    // sent to the model, or not permitted for this user).
    const validatedIds = new Set(validatedCitations.map((c) => c.document_id));
    rejectedCitationIds = rawCitationIds.filter((id) => !validatedIds.has(id));

    // Strip raw [[DOC-ID]] markers from the answer text.
    answer = stripCitations(llmResult.answer);

    // Check for the neutral response using an EXACT match, not a
    // broad substring. The model is instructed to return the exact
    // neutral string when it cannot answer. A broad substring match
    // can erase a legitimate qualified answer that happens to
    // contain those words.
    if (answer.trim() === NEUTRAL_RESPONSE) {
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    } else if (rejectedCitationIds.length > 0) {
      // The model supplied at least one unsupported citation. Do NOT
      // silently drop it and display the remaining answer as verified.
      // Reject the response: return the neutral fallback with a
      // validation error, and do NOT present any citations.
      citationValidationError =
        `The model referenced ${rejectedCitationIds.length} document(s) ` +
        `that were not in the permitted excerpts sent to it: ` +
        `[${rejectedCitationIds.join(", ")}]. The response is rejected.`;
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    } else if (validatedCitations.length === 0) {
      // The answer is substantive (not the neutral response) but
      // has zero valid citations. Reject it: an answer without
      // supporting evidence must not be displayed as verified.
      citationValidationError =
        `The model returned a substantive answer with no valid citations. ` +
        `Every positive answer must cite at least one document from the ` +
        `provided evidence. The response is rejected.`;
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    }
  }

  // Record audit event.
  // Always report the retrieved document IDs, even if the LLM is not
  // configured. This allows permission filtering to be verified
  // independently of the model.
  const decisions = buildDocumentDecisions(
    evaluated_document_ids,
    permitted_document_ids,
    modelContextIds,
    excerpts,
  );

  recordAuditEvent({
    request_id: requestId,
    user_id: user.id,
    query,
    timestamp,
    evaluated_document_decisions: decisions,
    model_context_document_ids: modelContextIds,
    model_context_document_versions: modelContextVersions,
    final_answer: answer,
    citations: validatedCitations.map((c) => c.document_id),
    flags,
  });

  const response: AskResponse = {
    request_id: requestId,
    answer,
    citations: validatedCitations,
    model_configured: config.configured,
    model_provider: config.provider,
    model_model: config.model,
    model_context_document_ids: modelContextIds,
    model_error: modelError,
    citation_validation_error: citationValidationError,
    rejected_citation_ids: rejectedCitationIds,
  };

  return NextResponse.json(response);
}

// Validate that every citation ID is in the permitted set AND was
// part of the excerpts sent to the model. Returns the set of valid
// citations. The caller is responsible for rejecting the response if
// any raw citation IDs were invalid — we do NOT silently drop them.
function validateCitations(
  userId: string,
  rawIds: string[],
  excerpts: ExcerptRef[],
): Citation[] {
  const excerptMap = new Map(excerpts.map((e) => [e.document_id, e]));
  const validated: Citation[] = [];
  const seen = new Set<string>();

  for (const id of rawIds) {
    if (seen.has(id)) continue;
    seen.add(id);

    // Must be in the model context (excerpt sent to LLM).
    const excerpt = excerptMap.get(id);
    if (!excerpt) continue;

    // Must be permitted (double-check ACL independently).
    if (!canRead(userId, id)) continue;

    validated.push({
      document_id: id,
      title: excerpt.document_title,
      platform: excerpt.document_platform as Citation["platform"],
      version: excerpt.document_version,
    });
  }

  return validated;
}

// ── Shared production citation validator ────────────────────────
//
// Exported so test scripts exercise the SAME logic as the production
// route, instead of duplicating (and potentially diverging from) it.
// Controlled tests should call this function with simulated
// LlmCallResult objects.

export interface ProcessLlmResultInput {
  document_id: string;
  document_title: string;
  document_platform: string;
  document_version: number;
}

export interface ProcessLlmResultOutput {
  answer: string;
  validatedCitations: string[];
  rejectedCitationIds: string[];
  modelError: string | null;
  citationValidationError: string | null;
}

export function processLlmResult(
  llmResult: { ok: boolean; answer: string | null; error?: string },
  userId: string,
  excerpts: ProcessLlmResultInput[],
): ProcessLlmResultOutput {
  let answer: string;
  let validatedCitations: string[] = [];
  let modelError: string | null = null;
  let citationValidationError: string | null = null;
  const rejectedCitationIds: string[] = [];

  if (!llmResult.ok || !llmResult.answer) {
    modelError = llmResult.error ?? "Model call failed.";
    answer = NEUTRAL_RESPONSE;
    validatedCitations = [];
  } else {
    const rawCitationIds = extractCitationIds(llmResult.answer);
    const excerptMap = new Map(excerpts.map((e) => [e.document_id, e]));
    const seen = new Set<string>();

    for (const id of rawCitationIds) {
      if (seen.has(id)) continue;
      seen.add(id);

      const excerpt = excerptMap.get(id);
      if (!excerpt) {
        rejectedCitationIds.push(id);
        continue;
      }
      if (!canRead(userId, id)) {
        rejectedCitationIds.push(id);
        continue;
      }
      validatedCitations.push(id);
    }

    answer = stripCitations(llmResult.answer);

    if (answer.trim() === NEUTRAL_RESPONSE) {
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    } else if (rejectedCitationIds.length > 0) {
      citationValidationError =
        `The model referenced ${rejectedCitationIds.length} document(s) ` +
        `that were not in the permitted excerpts sent to it: ` +
        `[${rejectedCitationIds.join(", ")}]. The response is rejected.`;
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    } else if (validatedCitations.length === 0) {
      citationValidationError =
        `The model returned a substantive answer with no valid citations. ` +
        `Every positive answer must cite at least one document from the ` +
        `provided evidence. The response is rejected.`;
      answer = NEUTRAL_RESPONSE;
      validatedCitations = [];
    }
  }

  return { answer, validatedCitations, rejectedCitationIds, modelError, citationValidationError };
}
