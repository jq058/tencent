// Controlled test fixtures for LLM failure-path testing.
//
// This module is imported ONLY by test runners (src/test/*.mts).
// It is never imported by application code. It provides simulated
// LlmCallResult objects that mimic real ADP failure modes.
//
// These fixtures do NOT touch the real ADP API and do NOT consume
// quota. They are completely separate from the running website.

import type { LlmCallResult } from "@/lib/llm";
import { extractCitationIds } from "@/lib/llm";

/**
 * Simulated quota error from ADP.
 */
export function fixtureQuotaError(): LlmCallResult {
  return {
    ok: false,
    answer: null,
    raw_citation_ids: [],
    error:
      "Workflow runtime error: Insufficient LLM resources | Your account balance or quota is insufficient for this request. Please top up your account or use a free model.",
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated connection failure from ADP.
 */
export function fixtureConnectionError(): LlmCallResult {
  return {
    ok: false,
    answer: null,
    raw_citation_ids: [],
    error: "ADP connection failed: ECONNREFUSED 10.0.0.1:443",
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated mid-stream disconnect from ADP.
 */
export function fixtureStreamDisconnect(): LlmCallResult {
  return {
    ok: false,
    answer: null,
    raw_citation_ids: [],
    error: "ADP stream read error: read ECONNRESET",
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated empty response from ADP.
 */
export function fixtureEmptyResponse(): LlmCallResult {
  return {
    ok: false,
    answer: null,
    raw_citation_ids: [],
    error: "ADP returned an empty response.",
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated substantive answer with valid citations (all in the
 * provided excerpts set).
 */
export function fixtureValidAnswer(text: string): LlmCallResult {
  return {
    ok: true,
    answer: text,
    raw_citation_ids: extractCitationIds(text),
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated answer that cites an unknown document ID (not in any
 * permitted set).
 */
export function fixtureUnknownCitation(answerText: string): LlmCallResult {
  // Inject a citation to a document that doesn't exist anywhere.
  const text = `${answerText} [[FAKE-DOC-999]]`;
  return {
    ok: true,
    answer: text,
    raw_citation_ids: extractCitationIds(text),
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated answer that cites a real document that is permitted for
 * another user but NOT in the current request's excerpts.
 */
export function fixturePermittedButNotSent(
  answerText: string,
  docId: string,
): LlmCallResult {
  const text = `${answerText} [[${docId}]]`;
  return {
    ok: true,
    answer: text,
    raw_citation_ids: extractCitationIds(text),
    provider: "adp",
    model: "adp-test-fixture",
  };
}

/**
 * Simulated substantive answer with no citations at all.
 */
export function fixtureNoCitationAnswer(answerText: string): LlmCallResult {
  return {
    ok: true,
    answer: answerText,
    raw_citation_ids: [],
    provider: "adp",
    model: "adp-test-fixture",
  };
}
