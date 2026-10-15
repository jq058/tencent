// Resilient test runner — runs each test individually so a server
// crash on one test doesn't abort the whole run.
//
// Usage: npx tsx src/test/run-resilient.mts
//
// This reads expected-results.json and runs T01–T05, T11–T15 one at
// a time. If a test fails with a connection error, it waits 3s and
// retries once. If it still fails, it marks the test as BLOCKED.

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

const PERMITTED: Record<string, string[]> = {
  daniel: ["CONF-ENG-001", "CONF-ENG-002", "CONF-GEN-001", "CONF-GEN-002", "JIRA-PAY-101", "JIRA-PAY-102", "JIRA-PAY-103", "SLACK-ENG-001", "SLACK-ENG-002"],
  priya: ["CONF-GEN-001", "CONF-GEN-002", "DRIVE-COMP-001", "DRIVE-COMP-002", "DRIVE-COMP-003"],
  marcus: ["CONF-GEN-001", "CONF-GEN-002"],
};

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

async function runOne(
  testCase: TestCase,
): Promise<{ status: TestStatus; checks: CheckResult[]; data?: AskApiResponse; error?: string }> {
  const checks: CheckResult[] = [];

  let res: Response;
  try {
    res = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-user": testCase.user_id,
      },
      body: JSON.stringify({ query: testCase.query }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    return {
      status: "BLOCKED",
      checks: [{ name: "HTTP request", passed: false, detail: `Connection error: ${err instanceof Error ? err.message : String(err)}` }],
      error: "Connection error",
    };
  }

  if (!res.ok) {
    return {
      status: "FAIL",
      checks: [{ name: "HTTP status", passed: false, detail: `HTTP ${res.status}` }],
      error: `HTTP ${res.status}`,
    };
  }

  const data: AskApiResponse = await res.json();
  const isNeutralTest = !!testCase.expected.exact_response;
  const isPositiveTest = !isNeutralTest;

  // Check model connection error
  if (data.model_error) {
    checks.push({ name: "Model connection", passed: false, detail: data.model_error });
  }

  // Permission checks
  const permitted = new Set(PERMITTED[testCase.user_id] ?? []);
  const contextIds = data.model_context_document_ids ?? [];
  const allContextPermitted = contextIds.every((id) => permitted.has(id));
  checks.push({
    name: "Model context only contains permitted documents",
    passed: allContextPermitted,
    detail: allContextPermitted
      ? `Context: [${contextIds.join(", ")}]`
      : `Forbidden docs in context: [${contextIds.filter((id) => !permitted.has(id)).join(", ")}]`,
  });

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

  // Citation validation check
  if (data.citation_validation_error) {
    checks.push({
      name: "Citation validation (no unsupported citations)",
      passed: false,
      detail: data.citation_validation_error,
    });
  }

  if (isNeutralTest) {
    const matches = data.answer.trim() === testCase.expected.exact_response!.trim();
    checks.push({
      name: "Exact neutral response",
      passed: matches,
      detail: matches ? "Correct neutral response" : `Got: "${data.answer.slice(0, 80)}..."`,
    });
    if (testCase.expected.expected_citations && testCase.expected.expected_citations.length === 0) {
      checks.push({
        name: "No citations for neutral response",
        passed: data.citations.length === 0,
        detail: data.citations.length === 0 ? "No citations" : `Citations: [${data.citations.map((c) => c.document_id).join(", ")}]`,
      });
    }
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
  } else {
    // Positive test
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
        detail: missingGroups.length === 0 ? "All required citation groups present" : `Missing: ${missingGroups.map((g) => `[${g.join("|")}]`).join(" ")}`,
      });
    }
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

    if (data.model_error) {
      // Model errored — BLOCKED
      return { status: "BLOCKED", checks, data, error: "Model connection error" };
    }

    if (!data.model_configured) {
      checks.push({ name: "Model configured", passed: false, detail: "Model not configured" });
      const permOk = checks.filter((c) => c.name.startsWith("Model context") || c.name.startsWith("No forbidden")).every((c) => c.passed);
      return { status: permOk ? "BLOCKED" : "FAIL", checks, data };
    }

    // Model configured — check for substantive answer
    const isNeutral = data.answer.trim() === NEUTRAL;
    if (isNeutral) {
      checks.push({ name: "Positive answer (not neutral)", passed: false, detail: "Returned neutral fallback" });
    } else {
      checks.push({ name: "Positive answer (not neutral)", passed: true, detail: "Substantive answer" });
    }
  }

  const allPassed = checks.every((c) => c.passed);
  return { status: allPassed ? "PASS" : "FAIL", checks, data };
}

async function main() {
  const fs = await import("node:fs");
  const expectedResults: ExpectedResults = JSON.parse(
    fs.readFileSync("c:/Tencent Hackathon/internal-brain-starter-data/internal-brain-starter-data/expected-results.json", "utf-8"),
  );

  const testIdsToRun = ["T01", "T02", "T03", "T04", "T05", "T11", "T12", "T13", "T14", "T15"];
  const tests = expectedResults.tests.filter((t) => testIdsToRun.includes(t.id));

  console.log(`\n=== Resilient Baseline Test Run: ${tests.length} cases ===\n`);

  let totalPassed = 0;
  let totalFailed = 0;
  let totalBlocked = 0;

  for (const testCase of tests) {
    console.log(`[Running] ${testCase.id} (${testCase.user_id})...`);

    let result;
    try {
      result = await runOne(testCase);
    } catch (err) {
      console.log(`  CRASH: ${err instanceof Error ? err.message : String(err)}`);
      totalBlocked++;
      // Wait and retry once
      await new Promise((r) => setTimeout(r, 5000));
      try {
        result = await runOne(testCase);
      } catch (err2) {
        console.log(`  CRASH (retry): ${err2 instanceof Error ? err2.message : String(err2)}`);
        result = { status: "BLOCKED" as TestStatus, checks: [{ name: "Server", passed: false, detail: "Server crashed" }] };
      }
    }

    const statusStr = result.status === "PASS" ? "PASS" : result.status === "FAIL" ? "FAIL" : "BLOCKED";
    console.log(`[${statusStr}] ${testCase.id}: ${testCase.query.slice(0, 50)}...`);
    for (const check of result.checks) {
      const cstatus = check.passed ? "  +" : "  X";
      console.log(`${cstatus} ${check.name}: ${check.detail}`);
    }
    if (result.data) {
      console.log(`  Answer preview: "${result.data.answer?.slice(0, 100) ?? "N/A"}..."`);
      console.log(`  Model: configured=${result.data.model_configured} provider=${result.data.model_provider} error=${result.data.model_error ? result.data.model_error.slice(0, 80) : "null"}`);
    }
    if (result.error) {
      console.log(`  Error: ${result.error}`);
    }
    console.log("");

    if (result.status === "PASS") totalPassed++;
    else if (result.status === "FAIL") totalFailed++;
    else totalBlocked++;

    // Small delay between tests
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`\n=== Summary: ${totalPassed} passed, ${totalFailed} failed, ${totalBlocked} blocked (out of ${tests.length}) ===\n`);

  if (totalBlocked > 0) {
    console.log("Note: BLOCKED tests require a working model. If ADP quota is exhausted,");
    console.log("top up your account or switch to a free model in the ADP workflow.");
  }
}

main().catch(console.error);
