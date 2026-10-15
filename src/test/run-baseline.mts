// Test runner for baseline cases T01–T05, T11–T15.
// Run with: npx tsx src/test/run-baseline.mts
//
// This script calls the /api/ask endpoint for each test case,
// checks model-input documents and final answers against
// expected-results.json, and reports pass/fail/blocked.
//
// Status meanings:
//   PASS    — all checks passed
//   FAIL    — at least one check failed
//   BLOCKED — the test requires a configured model (positive-answer
//             test) but no model is available. The permission and
//             retrieval checks still pass, but the answer-content
//             checks cannot be evaluated.

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

interface ExpectedResults {
  standard_neutral_response: string;
  tests: TestCase[];
}

interface AskApiResponse {
  request_id: string;
  answer: string;
  citations: { document_id: string }[];
  model_configured: boolean;
  model_provider: string | null;
  model_model: string | null;
  model_context_document_ids: string[];
  model_error: string | null;
  citation_validation_error: string | null;
  rejected_citation_ids: string[];
}

type TestStatus = "PASS" | "FAIL" | "BLOCKED";

const NEUTRAL = "I couldn't find information in the sources available to you.";

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

interface TestResult {
  testId: string;
  status: TestStatus;
  checks: CheckResult[];
  response: AskApiResponse;
  blockReason?: string;
}

async function runTest(
  testCase: TestCase,
  _expectedResults: ExpectedResults,
): Promise<TestResult> {
  const checks: CheckResult[] = [];

  const res = await fetch("http://localhost:3000/api/ask", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-demo-user": testCase.user_id,
    },
    body: JSON.stringify({ query: testCase.query }),
  });

  if (!res.ok) {
    checks.push({ name: "HTTP status", passed: false, detail: `HTTP ${res.status}` });
    return { testId: testCase.id, status: "FAIL", checks, response: {} as AskApiResponse };
  }

  const data: AskApiResponse = await res.json();

  // Determine if this is a "positive answer" test (requires model)
  // or a "neutral response" test.
  const isNeutralTest = !!testCase.expected.exact_response;
  const isPositiveTest = !isNeutralTest;

  // Check if there was a model connection error.
  if (data.model_error) {
    checks.push({
      name: "Model connection",
      passed: false,
      detail: data.model_error,
    });
    // If this is a positive test and the model errored, it's blocked
    // (not a code failure — just can't evaluate answer quality).
    if (isPositiveTest) {
      // Still check permissions, but answer quality is blocked.
      addPermissionChecks(checks, testCase, data);
      return {
        testId: testCase.id,
        status: "BLOCKED",
        checks,
        response: data,
        blockReason: "Model connection error — cannot evaluate answer quality.",
      };
    }
    // For neutral tests, a model error is still a failure if the
    // answer doesn't match. But the neutral fallback is correct
    // behavior even with a model error.
  }

  // ── Permission checks (always evaluated) ──

  addPermissionChecks(checks, testCase, data);

  // ── Neutral-response tests ──

  if (isNeutralTest) {
    // Check 4: Exact neutral response.
    const matches = data.answer.trim() === testCase.expected.exact_response!.trim();
    checks.push({
      name: "Exact neutral response",
      passed: matches,
      detail: matches ? "Correct neutral response" : `Got: "${data.answer.slice(0, 80)}..."`,
    });

    // Check: No citations for neutral response.
    if (testCase.expected.expected_citations && testCase.expected.expected_citations.length === 0) {
      checks.push({
        name: "No citations for neutral response",
        passed: data.citations.length === 0,
        detail: data.citations.length === 0 ? "No citations" : `Citations: [${data.citations.map((c) => c.document_id).join(", ")}]`,
      });
    }

    // Check: No forbidden literals.
    if (testCase.expected.forbidden_literals) {
      const answerLower = data.answer.toLowerCase();
      const found = testCase.expected.forbidden_literals.filter((lit) =>
        answerLower.includes(lit.toLowerCase()),
      );
      checks.push({
        name: "No forbidden literals in answer",
        passed: found.length === 0,
        detail: found.length === 0 ? "No forbidden literals found" : `Forbidden literals found: [${found.join(", ")}]`,
      });
    }

    // All checks determine pass/fail for neutral tests.
    const allPassed = checks.every((c) => c.passed);
    return { testId: testCase.id, status: allPassed ? "PASS" : "FAIL", checks, response: data };
  }

  // ── Positive-answer tests ──

  // Check: Required citation groups satisfied.
  // Check ONLY against citations actually returned in the answer,
  // NOT documents merely included in model context.
  if (testCase.expected.required_citation_groups && testCase.expected.required_citation_groups.length > 0) {
    const citationIds = new Set(data.citations.map((c) => c.document_id));
    const missingGroups: string[][] = [];
    for (const group of testCase.expected.required_citation_groups) {
      const found = group.some((id) => citationIds.has(id));
      if (!found) missingGroups.push(group);
    }
    checks.push({
      name: "Required citation groups (from returned citations)",
      passed: missingGroups.length === 0,
      detail: missingGroups.length === 0
        ? `All present: [${data.citations.map((c) => c.document_id).join(", ")}]`
        : `Missing: ${missingGroups.map((g) => `[${g.join("|")}]`).join(" ")}. Returned: [${data.citations.map((c) => c.document_id).join(", ")}]`,
    });
  }

  // Check: No forbidden literals.
  if (testCase.expected.forbidden_literals) {
    const answerLower = data.answer.toLowerCase();
    const found = testCase.expected.forbidden_literals.filter((lit) =>
      answerLower.includes(lit.toLowerCase()),
    );
    checks.push({
      name: "No forbidden literals in answer",
      passed: found.length === 0,
      detail: found.length === 0 ? "No forbidden literals found" : `Forbidden literals found: [${found.join(", ")}]`,
    });
  }

  // ── Blocked vs Pass/Fail for positive tests ──

  if (!data.model_configured) {
    // Model not configured. Positive-answer tests are BLOCKED:
    // the answer is the neutral fallback, and we cannot evaluate
    // whether the model would have produced a correct answer.
    // Permission checks still pass/fail on their own.
    checks.push({
      name: "Model configured (required for positive answer)",
      passed: false,
      detail: "Model not configured — cannot evaluate answer quality.",
    });

    const permissionChecksPassed = checks
      .filter((c) => c.name.startsWith("Model context") || c.name.startsWith("No forbidden"))
      .every((c) => c.passed);

    if (permissionChecksPassed) {
      return {
        testId: testCase.id,
        status: "BLOCKED",
        checks,
        response: data,
        blockReason: "No model API key configured — answer quality cannot be evaluated.",
      };
    }
    return { testId: testCase.id, status: "FAIL", checks, response: data };
  }

  // Model IS configured. Positive tests must NOT pass merely because
  // they return the neutral fallback.
  const isNeutral = data.answer.trim() === NEUTRAL;
  if (isNeutral) {
    checks.push({
      name: "Positive answer (not neutral fallback)",
      passed: false,
      detail: "Model returned neutral fallback despite relevant evidence — positive test does NOT pass.",
    });
  } else {
    checks.push({
      name: "Positive answer (not neutral fallback)",
      passed: true,
      detail: "Model returned a substantive answer.",
    });
  }

  // Citation validation: if the model supplied unsupported citations,
  // the response was rejected. This is a FAIL (not a pass), even if
  // the model produced a substantive answer.
  if (data.citation_validation_error) {
    checks.push({
      name: "Citation validation (no unsupported citations)",
      passed: false,
      detail: data.citation_validation_error,
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return { testId: testCase.id, status: allPassed ? "PASS" : "FAIL", checks, response: data };
}

function addPermissionChecks(
  checks: CheckResult[],
  testCase: TestCase,
  data: AskApiResponse,
): void {
  const permittedSets: Record<string, string[]> = {
    daniel: ["CONF-ENG-001", "CONF-ENG-002", "CONF-GEN-001", "CONF-GEN-002", "JIRA-PAY-101", "JIRA-PAY-102", "JIRA-PAY-103", "SLACK-ENG-001", "SLACK-ENG-002"],
    priya: ["CONF-GEN-001", "CONF-GEN-002", "DRIVE-COMP-001", "DRIVE-COMP-002", "DRIVE-COMP-003"],
    marcus: ["CONF-GEN-001", "CONF-GEN-002"],
  };
  const permitted = new Set(permittedSets[testCase.user_id] ?? []);
  const contextIds = data.model_context_document_ids ?? [];
  const allContextPermitted = contextIds.every((id) => permitted.has(id));
  checks.push({
    name: "Model context only contains permitted documents",
    passed: allContextPermitted,
    detail: allContextPermitted
      ? `Context: [${contextIds.join(", ")}]`
      : `Forbidden docs in context: [${contextIds.filter((id) => !permitted.has(id)).join(", ")}]`,
  });

  // Check: No forbidden citation IDs.
  if (testCase.expected.forbidden_citation_ids) {
    const citationIds = data.citations.map((c) => c.document_id);
    const forbidden = testCase.expected.forbidden_citation_ids;
    const violations = citationIds.filter((id) => forbidden.includes(id));
    checks.push({
      name: "No forbidden citation IDs",
      passed: violations.length === 0,
      detail: violations.length === 0 ? "No forbidden citations" : `Forbidden citations found: [${violations.join(", ")}]`,
    });
  }
}

async function main() {
  const fs = await import("node:fs");
  const expectedResults: ExpectedResults = JSON.parse(
    fs.readFileSync("c:/Tencent Hackathon/internal-brain-starter-data/internal-brain-starter-data/expected-results.json", "utf-8"),
  );

  const testIdsToRun = ["T01", "T02", "T03", "T04", "T05", "T11", "T12", "T13", "T14", "T15"];
  const tests = expectedResults.tests.filter((t) => testIdsToRun.includes(t.id));

  console.log(`\n=== Baseline Test Run: ${tests.length} cases ===\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalBlocked = 0;
  const results: TestResult[] = [];

  for (const testCase of tests) {
    const result = await runTest(testCase, expectedResults);
    results.push(result);

    const statusStr =
      result.status === "PASS" ? "PASS" :
      result.status === "FAIL" ? "FAIL" : "BLOCKED";

    console.log(`[${statusStr}] ${testCase.id} (${testCase.user_id}): ${testCase.query.slice(0, 60)}...`);
    for (const check of result.checks) {
      const cstatus = check.passed ? "  +" : "  X";
      console.log(`${cstatus} ${check.name}: ${check.detail}`);
    }
    if (result.blockReason) {
      console.log(`  BLOCKED: ${result.blockReason}`);
    }
    console.log(`  Answer: "${result.response.answer?.slice(0, 120) ?? "N/A"}..."`);
    console.log(`  Model configured: ${result.response.model_configured}`);
    if (result.response.model_error) {
      console.log(`  Model error: ${result.response.model_error}`);
    }
    console.log("");

    if (result.status === "PASS") totalPassed++;
    else if (result.status === "FAIL") totalFailed++;
    else totalBlocked++;
  }

  console.log(`\n=== Summary: ${totalPassed} passed, ${totalFailed} failed, ${totalBlocked} blocked (out of ${tests.length}) ===\n`);

  // Report model config status
  const modelConfigured = results[0]?.response.model_configured ?? false;
  console.log(`Model configured: ${modelConfigured}`);
  if (totalBlocked > 0) {
    console.log(`\n${totalBlocked} test(s) are BLOCKED because no model API key is configured.`);
    console.log("Set ADP_APP_KEY in .env.local to evaluate answer quality.");
    console.log("Permission filtering and retrieval are verified via model_context_document_ids checks.");
  }
}

main().catch(console.error);
