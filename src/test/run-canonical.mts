// Canonical baseline test runner (component tests).
//
// Calls the application code directly (callLlm, citation validation,
// permission checks) to verify the LLM response and citation logic.
// These are COMPONENT tests — they do not substitute for HTTP tests
// against the running server, which are run separately.
//
// This runner:
//   1. Loads expected-results.json unmodified
//   2. For each test, resolves the user, retrieves permitted excerpts,
//      calls callLlm, validates citations
//   3. Checks required_citation_groups against citations actually
//      returned in the answer (NOT documents in model context)
//   4. Rejects substantive answers with no valid citations
//
// No retries, no restarts. If callLlm fails, the test is reported as-is.

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";

// Set env var before importing
process.env.ADP_APP_KEY =
  process.env.ADP_APP_KEY ||
  "hxboKSErIEVpcKlPTyLppVdFGOYcKGNuTmjZVxzdLZvVngfXjngSGCLDindjGcBBEBXnKsbdvmMxXLtbnvaNIIlhPUjdWRpCYabDlqwjeBfxhdGuxPgkQZWJMZGiOOLw";

// Import the application code
const { resolveSession } = await import("../lib/session");
const { retrieve } = await import("../lib/retrieval");
const { canRead } = await import("../lib/permissions");
const { callLlm, extractCitationIds, stripCitations } = await import("../lib/llm");
const { recordAuditEvent } = await import("../lib/audit");

interface TestExpected {
  requirements?: string[];
  required_citation_groups?: string[][];
  forbidden_literals?: string[];
  forbidden_claims?: string[];
  exact_response?: string;
  expected_citations?: string[];
  forbidden_citation_ids?: string[];
}

interface TestCase {
  id: string;
  user_id: string;
  state: string;
  query: string;
  expected: TestExpected;
}

const NEUTRAL = "I couldn't find information in the sources available to you.";
const PERMITTED: Record<string, string[]> = {
  daniel: ["CONF-ENG-001", "CONF-ENG-002", "CONF-GEN-001", "CONF-GEN-002", "JIRA-PAY-101", "JIRA-PAY-102", "JIRA-PAY-103", "SLACK-ENG-001", "SLACK-ENG-002"],
  priya: ["CONF-GEN-001", "CONF-GEN-002", "DRIVE-COMP-001", "DRIVE-COMP-002", "DRIVE-COMP-003"],
  marcus: ["CONF-GEN-001", "CONF-GEN-002"],
};

type TestStatus = "PASS" | "FAIL" | "BLOCKED";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface TestResult {
  testId: string;
  status: TestStatus;
  checks: CheckResult[];
  answer: string;
  modelError: string | null;
  citationValidationError: string | null;
  rejectedCitationIds: string[];
  modelContextIds: string[];
}

async function runOne(testCase: TestCase): Promise<TestResult> {
  const checks: CheckResult[] = [];
  const permitted = new Set(PERMITTED[testCase.user_id] ?? []);

  // 1. Resolve user
  const { user } = resolveSession(testCase.user_id);
  if (!user) {
    return {
      testId: testCase.id,
      status: "FAIL",
      checks: [{ name: "User resolution", passed: false, detail: `User ${testCase.user_id} not found` }],
      answer: "",
      modelError: null,
      citationValidationError: null,
      rejectedCitationIds: [],
      modelContextIds: [],
    };
  }

  // 2. Retrieve permitted excerpts
  const retrievalResult = retrieve(user.id, testCase.query);
  const excerpts = retrievalResult.excerpts;

  // 3. Check model config
  const config = { configured: !!process.env.ADP_APP_KEY, provider: "adp" as string | null };

  // 4. Call LLM
  let llmResult;
  try {
    llmResult = await callLlm(
      testCase.query,
      excerpts.map((e) => ({
        document_id: e.document_id,
        document_title: e.document_title,
        content: e.content,
      })),
      user.id,
    );
  } catch (err) {
    return {
      testId: testCase.id,
      status: "FAIL",
      checks: [{ name: "LLM call", passed: false, detail: `Crashed: ${err instanceof Error ? err.message : String(err)}` }],
      answer: "",
      modelError: null,
      citationValidationError: null,
      rejectedCitationIds: [],
      modelContextIds: excerpts.map((e: any) => e.document_id),
    };
  }

  const modelContextIds = excerpts.map((e) => e.document_id);

  // Permission check
  const allContextPermitted = modelContextIds.every((id) => permitted.has(id));
  checks.push({
    name: "Model context only contains permitted documents",
    passed: allContextPermitted,
    detail: `Context: [${modelContextIds.join(", ")}]`,
  });

  // Model error check
  if (llmResult.error) {
    checks.push({ name: "Model connection", passed: false, detail: llmResult.error });
  }

  let answer = llmResult.answer || "";
  let validatedCitations: string[] = [];
  let rejectedCitationIds: string[] = [];
  let citationValidationError: string | null = null;

  if (llmResult.ok && answer) {
    // Extract and validate citations
    const rawCitationIds = extractCitationIds(answer);
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
      if (!canRead(user.id, id)) {
        rejectedCitationIds.push(id);
        continue;
      }
      validatedCitations.push(id);
    }

    answer = stripCitations(answer);

    if (answer.includes("I couldn't find information")) {
      answer = NEUTRAL;
      validatedCitations = [];
    } else if (rejectedCitationIds.length > 0) {
      citationValidationError =
        `The model referenced ${rejectedCitationIds.length} document(s) ` +
        `that were not in the permitted excerpts: [${rejectedCitationIds.join(", ")}].`;
      answer = NEUTRAL;
      validatedCitations = [];
    }

    if (citationValidationError) {
      checks.push({ name: "Citation validation", passed: false, detail: citationValidationError });
    }
  }

  // Check if this is a neutral or positive test
  const isNeutralTest = !!testCase.expected.exact_response;

  if (isNeutralTest) {
    const matches = answer.trim() === testCase.expected.exact_response!.trim();
    checks.push({
      name: "Exact neutral response",
      passed: matches,
      detail: matches ? "Correct" : `Got: "${answer.slice(0, 60)}..."`,
    });
    if (testCase.expected.expected_citations && testCase.expected.expected_citations.length === 0) {
      checks.push({
        name: "No citations for neutral response",
        passed: validatedCitations.length === 0,
        detail: validatedCitations.length === 0 ? "No citations" : `Citations: [${validatedCitations.join(", ")}]`,
      });
    }
    if (testCase.expected.forbidden_literals) {
      const answerLower = answer.toLowerCase();
      const found = testCase.expected.forbidden_literals.filter((lit) => answerLower.includes(lit.toLowerCase()));
      checks.push({
        name: "No forbidden literals in answer",
        passed: found.length === 0,
        detail: found.length === 0 ? "Clean" : `Found: [${found.join(",")}]`,
      });
    }
  } else {
    // Positive test
    if (llmResult.error) {
      return {
        testId: testCase.id,
        status: "BLOCKED",
        checks,
        answer,
        modelError: llmResult.error ?? null,
        citationValidationError,
        rejectedCitationIds,
        modelContextIds,
      };
    }
    if (!config.configured) {
      return {
        testId: testCase.id,
        status: "BLOCKED",
        checks,
        answer,
        modelError: null,
        citationValidationError,
        rejectedCitationIds,
        modelContextIds,
      };
    }

    if (testCase.expected.required_citation_groups) {
      // Check against citations ACTUALLY RETURNED in the answer,
      // NOT documents merely included in model context.
      const returnedIds = new Set<string>(validatedCitations);
      const missing = testCase.expected.required_citation_groups.filter(
        (g) => !g.some((id) => returnedIds.has(id)),
      );
      checks.push({
        name: "Required citation groups (from returned citations)",
        passed: missing.length === 0,
        detail: missing.length === 0
          ? `All present: [${validatedCitations.join(", ")}]`
          : `Missing: ${missing.map((g) => "[" + g.join("|") + "]").join(" ")}. Returned: [${validatedCitations.join(", ")}]`,
      });
    }
    if (testCase.expected.forbidden_literals) {
      const answerLower = answer.toLowerCase();
      const found = testCase.expected.forbidden_literals.filter((lit) => answerLower.includes(lit.toLowerCase()));
      checks.push({
        name: "No forbidden literals",
        passed: found.length === 0,
        detail: found.length === 0 ? "Clean" : `Found: [${found.join(",")}]`,
      });
    }
    const isNeutral = answer.trim() === NEUTRAL;
    checks.push({
      name: "Positive answer (not neutral)",
      passed: !isNeutral,
      detail: isNeutral ? "Neutral fallback" : "Substantive",
    });
    // Reject substantive answers with no valid citations.
    if (!isNeutral) {
      checks.push({
        name: "Substantive answer has at least one valid citation",
        passed: validatedCitations.length > 0,
        detail: validatedCitations.length > 0
          ? `[${validatedCitations.join(", ")}]`
          : "No valid citations — should be rejected",
      });
    }
  }

  const allPassed = checks.every((c) => c.passed);
  return {
    testId: testCase.id,
    status: allPassed ? "PASS" : "FAIL",
    checks,
    answer,
    modelError: llmResult.error ?? null,
    citationValidationError,
    rejectedCitationIds,
    modelContextIds,
  };
}

async function main() {
  const expectedResults = JSON.parse(
    fs.readFileSync(
      "c:/Tencent Hackathon/internal-brain-starter-data/internal-brain-starter-data/expected-results.json",
      "utf-8",
    ),
  );

  const testIdsToRun = ["T01", "T02", "T03", "T04", "T05", "T11", "T12", "T13", "T14", "T15"];
  const tests = expectedResults.tests.filter((t: TestCase) => testIdsToRun.includes(t.id));

  console.log(`\n=== Canonical Baseline Test Run: ${tests.length} cases ===`);
  console.log("Mode: direct component calls (callLlm + citation validation)");
  console.log("Evaluation: required_citation_groups checked against returned citations");
  console.log("");

  let totalPassed = 0;
  let totalFailed = 0;
  let totalBlocked = 0;

  for (const testCase of tests) {
    const result = await runOne(testCase);
    const statusStr = result.status === "PASS" ? "PASS" : result.status === "FAIL" ? "FAIL" : "BLOCKED";
    console.log(`[${statusStr}] ${result.testId} (${testCase.user_id}): ${testCase.query.slice(0, 50)}...`);
    for (const check of result.checks) {
      console.log(`  ${check.passed ? "+" : "X"} ${check.name}: ${check.detail}`);
    }
    console.log(`  Answer: "${result.answer?.slice(0, 100) ?? "N/A"}..."`);
    if (result.modelError) console.log(`  Model error: ${result.modelError.slice(0, 100)}`);
    console.log("");

    if (result.status === "PASS") totalPassed++;
    else if (result.status === "FAIL") totalFailed++;
    else totalBlocked++;
  }

  console.log(`\n=== Summary: ${totalPassed} passed, ${totalFailed} failed, ${totalBlocked} blocked (out of ${tests.length}) ===`);
}

main().catch(console.error);
