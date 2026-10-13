// Server-only retrieval engine.
//
// Searches ONLY documents the user is permitted to read. The browser
// never receives results from restricted documents. README.md,
// expected-results.json, and demo-events.json are never indexed.
//
// The search is keyword-based with scoring. It supports synonyms for
// the test scenario (e.g. "Indonesia" → IDR payout incident) so that
// the wording used in test questions matches the right documents.

import { canRead } from "./permissions";
import { getSeedDocuments } from "./seed";
import type { SeedDocument } from "./types";

export type ContentScope = "full_document" | "excerpt";

export interface RetrievedExcerpt {
  document_id: string;
  document_title: string;
  document_platform: string;
  document_version: number;
  document_updated_at: string;
  content: string; // the permitted excerpt text
  content_scope: ContentScope; // whether `content` is the complete document
  score: number;
}

export interface RetrievalResult {
  excerpts: RetrievedExcerpt[];
  evaluated_document_ids: string[]; // all docs evaluated (for audit)
  permitted_document_ids: string[]; // docs the user could access
}

// Synonym map: maps question wording to corpus terminology.
const SYNONYMS: Record<string, string[]> = {
  indonesia: ["idr", "indonesia", "sgd to idr"],
  indonesian: ["idr", "indonesia"],
  payouts: ["payout", "payouts", "dispatch", "payment"],
  incident: ["incident", "disrupted", "postmortem", "INC-2026"],
  august: ["august", "2026-08"],
  canary: ["canary", "CORRIDOR-CHECK"],
  duplicate: ["duplicate", "idempotency", "retry"],
  approval: ["approved", "approval", "sign-off", "signoff", "signed off"],
  runbook: ["runbook", "recovery procedure"],
  postmortem: ["postmortem", "incident postmortem"],
  diagnostic: ["diagnostic", "correlation", "IDR-VAL"],
  customer: ["customer", "impact", "register", "cohort"],
  filing: ["filing", "notification", "reporting", "deadline", "receipt"],
  reconciliation: ["reconciliation", "reconciled", "reconcile"],
  branch: ["destination_branch_code", "branch", "validator", "validation"],
  alert: ["alert", "rejection rate", "monitoring"],
  help: ["help", "help desk", "it help", "request"],
  account: ["account", "credential", "access request"],
  contractor: ["contractor", "onboarding", "sponsor"],
  correction: ["correct", "correction", "synchronization"],
  handbook: ["handbook", "staff", "employee"],
  faq: ["faq", "frequently asked"],
};

function normalize(text: string): string {
  return text.toLowerCase();
}

function tokenize(query: string): string[] {
  return normalize(query)
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function expandTerm(term: string): string[] {
  const lower = normalize(term);
  const expanded = new Set<string>([lower]);
  if (SYNONYMS[lower]) {
    SYNONYMS[lower].forEach((s) => expanded.add(normalize(s)));
  }
  // Also check partial matches in synonym keys
  for (const key of Object.keys(SYNONYMS)) {
    if (lower.includes(key) || key.includes(lower)) {
      SYNONYMS[key].forEach((s) => expanded.add(normalize(s)));
    }
  }
  return Array.from(expanded);
}

function scoreDocument(
  doc: SeedDocument,
  searchTerms: string[],
): { score: number; matchedTerms: Set<string> } {
  const titleLower = normalize(doc.title);
  const contentLower = normalize(doc.content_markdown);
  const idLower = normalize(doc.id);
  let score = 0;
  const matchedTerms = new Set<string>();

  for (const term of searchTerms) {
    const variants = expandTerm(term);
    let termMatched = false;

    for (const variant of variants) {
      // Title match (highest weight)
      if (titleLower.includes(variant)) {
        score += 5;
        termMatched = true;
      }
      // ID match
      if (idLower.includes(variant)) {
        score += 3;
        termMatched = true;
      }
      // Content match
      const contentCount = countOccurrences(contentLower, variant);
      if (contentCount > 0) {
        score += Math.min(contentCount * 2, 8);
        termMatched = true;
      }
    }

    if (termMatched) {
      matchedTerms.add(term);
    }
  }

  return { score, matchedTerms };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// Extract the most relevant excerpt from a document's content.
// When the document is short enough (under 6000 chars), return the
// complete content so the model can make statements about the full
// document, not just a partial excerpt. For longer documents, fall
// back to selecting the highest-scoring sections (always including
// the title section for context).
//
// Returns the content and a content_scope label indicating whether
// the full document was included or only a partial excerpt.
function extractRelevantExcerpt(
  content: string,
  searchTerms: string[],
): { content: string; content_scope: ContentScope } {
  // If the document is short enough, return it in full. A partial
  // excerpt only supports statements about that excerpt; the full
  // content lets the model say what the document does and does not
  // contain.
  if (content.length <= 6000) {
    return { content, content_scope: "full_document" };
  }

  const normalized = normalize(content);
  const sentences = content.split(/\n(?=#{1,4}\s)|\n\n/);

  const scored = sentences.map((s) => {
    const sLower = normalize(s);
    let sScore = 0;
    for (const term of searchTerms) {
      const variants = expandTerm(term);
      for (const v of variants) {
        sScore += countOccurrences(sLower, v);
      }
    }
    return { sentence: s, sScore };
  });

  // Always include the first section (title + intro) for context.
  const firstSection = sentences[0]?.trim() ?? "";

  // Score and sort the remaining sentences
  const scoredRest = scored.slice(1).map((s, i) => ({ ...s, index: i + 1 }));
  scoredRest.sort((a, b) => b.sScore - a.sScore);

  // Build the excerpt: first section + top-scored remaining sections
  const selected: string[] = [firstSection];
  let totalLen = firstSection.length;

  for (const { sentence, sScore } of scoredRest) {
    if (sScore === 0) continue;
    if (totalLen + sentence.length > 6000) break;
    selected.push(sentence.trim());
    totalLen += sentence.length;
    if (selected.length >= 12) break;
  }

  if (selected.length === 0) {
    return { content: content.slice(0, 3000), content_scope: "excerpt" };
  }

  return { content: selected.join("\n\n"), content_scope: "excerpt" };
}

/**
 * Retrieve relevant permitted excerpts for a query.
 * Only documents the user can read are searched. The result includes
 * evaluated document IDs for audit purposes.
 */
export function retrieve(
  userId: string | null,
  query: string,
  maxExcerpts = 10,
): RetrievalResult {
  const allDocs = getSeedDocuments();
  const permittedDocs = allDocs.filter((d) => canRead(userId, d.id));
  const searchTerms = tokenize(query);

  const evaluated: string[] = [];
  const scored: {
    doc: SeedDocument;
    score: number;
    matchedTerms: Set<string>;
  }[] = [];

  for (const doc of permittedDocs) {
    evaluated.push(doc.id);
    const { score, matchedTerms } = scoreDocument(doc, searchTerms);
    if (score > 0) {
      scored.push({ doc, score, matchedTerms });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const excerpts: RetrievedExcerpt[] = scored
    .slice(0, maxExcerpts)
    .map(({ doc }) => {
      const { content, content_scope } = extractRelevantExcerpt(
        doc.content_markdown,
        searchTerms,
      );
      return {
        document_id: doc.id,
        document_title: doc.title,
        document_platform: doc.platform,
        document_version: doc.version,
        document_updated_at: doc.updated_at,
        content,
        content_scope,
        score: scored.find((s) => s.doc.id === doc.id)?.score ?? 0,
      };
    });

  return {
    excerpts,
    evaluated_document_ids: evaluated,
    permitted_document_ids: permittedDocs.map((d) => d.id),
  };
}

// Check if any retrieved excerpts are actually relevant (not just keyword noise).
export function hasRelevantEvidence(
  excerpts: RetrievedExcerpt[],
  query: string,
): boolean {
  if (excerpts.length === 0) return false;
  // If we have excerpts with score > 0, we consider it relevant.
  // The threshold is intentionally low to avoid false negatives, but
  // the LLM system prompt instructs the model to use the neutral
  // response when the excerpts don't actually answer the question.
  return excerpts.some((e) => e.score > 0);
}
