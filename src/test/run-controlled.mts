// Controlled failure-path test runner.
//
// Tests the citation validation and error-handling logic by calling
// the SAME processLlmResult function exported from the production
// /api/ask route handler. This ensures tests exercise the real
// production code, not a duplicated (and potentially divergent) copy.
//
// These tests verify:
//   1. ADP quota error → model_error surfaced, neutral answer
//   2. Stream disconnect → model_error surfaced, neutral answer
//   3. Unknown citation → response rejected, neutral answer
//   4. Forbidden citation → response rejected (doc permitted for
//      another user but not the current user)
//   5. Permitted-but-not-sent citation → response rejected (doc
//      permitted for the user but not in the excerpts sent to the model)
//   6. Substantive answer with no citations → REJECTED
//   7. Valid answer with correct citations → passes
//
// Uses simulated LlmCallResult fixtures — no ADP quota consumed.

import {
  fixtureQuotaError,
  fixtureStreamDisconnect,
  fixtureValidAnswer,
  fixtureUnknownCitation,
  fixturePermittedButNotSent,
  fixtureNoCitationAnswer,
} from "./controlled-fixtures";
import { resolveSession } from "@/lib/session";
import { retrieve } from "@/lib/retrieval";
import { processLlmResult } from "@/app/api/ask/route";
import type { CheckResult, FixtureTestResult } from "./test-types";

const NEUTRAL = "I couldn't find information in the sources available to you.";

function runFixtureTest(
  name: string,
  llmResult: Parameters<typeof processLlmResult>[0],
  userId: string,
  query: string,
  checks: (result: ReturnType<typeof processLlmResult>) => CheckResult[],
): FixtureTestResult {
  const { user } = resolveSession(userId);
  if (!user) {
    return {
      name,
      status: "FAIL",
      checks: [{ name: "User resolution", passed: false, detail: `User ${userId} not found` }],
    };
  }

  const retrievalResult = retrieve(user.id, query);
  const excerpts = retrievalResult.excerpts.map((e) => ({
    document_id: e.document_id,
    document_title: e.document_title,
    document_platform: e.document_platform,
    document_version: e.document_version,
  }));
  const result = processLlmResult(llmResult, user.id, excerpts);
  const checkResults = checks(result);

  return {
    name,
    status: checkResults.every((c) => c.passed) ? "PASS" : "FAIL",
    checks: checkResults,
  };
}

async function main() {
  console.log("\n=== Controlled Failure-Path Tests ===");
  console.log("Mode: simulated LlmCallResult fixtures (no ADP quota consumed)");
  console.log("Validator: shared production processLlmResult (not duplicated)\n");

  const results: FixtureTestResult[] = [];

  // 1. Quota error
  results.push(
    runFixtureTest(
      "Quota error surfaces model_error and neutral answer",
      fixtureQuotaError(),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "model_error is set", passed: r.modelError !== null && r.modelError.includes("quota"), detail: r.modelError ?? "null" },
        { name: "Answer is neutral", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
      ],
    ),
  );

  // 2. Stream disconnect
  results.push(
    runFixtureTest(
      "Stream disconnect surfaces model_error and neutral answer",
      fixtureStreamDisconnect(),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "model_error is set", passed: r.modelError !== null && r.modelError.includes("ECONNRESET"), detail: r.modelError ?? "null" },
        { name: "Answer is neutral", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
      ],
    ),
  );

  // 3. Unknown citation (FAKE-DOC-999)
  results.push(
    runFixtureTest(
      "Unknown citation rejected, response not displayed",
      fixtureUnknownCitation("The payout issue was caused by a missing branch code."),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "citation_validation_error is set", passed: r.citationValidationError !== null, detail: r.citationValidationError ?? "null" },
        { name: "Rejected citation includes FAKE-DOC-999", passed: r.rejectedCitationIds.includes("FAKE-DOC-999"), detail: r.rejectedCitationIds.join(", ") },
        { name: "Answer is neutral (not displayed)", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No validated citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
      ],
    ),
  );

  // 4. Forbidden citation: a Compliance document (DRIVE-COMP-001)
  //    cited by Daniel. Daniel does NOT have access to Compliance
  //    documents — this tests the forbidden-document path.
  results.push(
    runFixtureTest(
      "Forbidden citation (Compliance doc cited by Daniel) rejected",
      fixturePermittedButNotSent("The compliance report shows 340 affected payouts.", "DRIVE-COMP-001"),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "citation_validation_error is set", passed: r.citationValidationError !== null, detail: r.citationValidationError ?? "null" },
        { name: "Rejected citation includes DRIVE-COMP-001", passed: r.rejectedCitationIds.includes("DRIVE-COMP-001"), detail: r.rejectedCitationIds.join(", ") },
        { name: "Answer is neutral (not displayed)", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No validated citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
      ],
    ),
  );

  // 5. Permitted-but-not-sent citation: CONF-GEN-001 is permitted
  //    for Daniel but NOT in the excerpts for this query (the
  //    retrieval for "Indonesia payouts" returns ENG docs, not the
  //    general handbook). This tests the "permitted document omitted
  //    from the actual model context" path.
  results.push(
    runFixtureTest(
      "Permitted-but-not-sent citation rejected",
      fixturePermittedButNotSent("The payout issue was resolved by 14:10.", "CONF-GEN-001"),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "citation_validation_error is set", passed: r.citationValidationError !== null, detail: r.citationValidationError ?? "null" },
        { name: "Rejected citation includes CONF-GEN-001", passed: r.rejectedCitationIds.includes("CONF-GEN-001"), detail: r.rejectedCitationIds.join(", ") },
        { name: "Answer is neutral (not displayed)", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No validated citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
      ],
    ),
  );

  // 6. Substantive answer with no citations — NOW REJECTED
  //    The production guard rejects substantive answers that have
  //    zero valid citations. This test now verifies the rejection.
  results.push(
    runFixtureTest(
      "Substantive answer with no citations is rejected",
      fixtureNoCitationAnswer("The payout issue was caused by a missing branch code and was resolved by 14:10."),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "citation_validation_error is set", passed: r.citationValidationError !== null, detail: r.citationValidationError ?? "null" },
        { name: "Answer is neutral (rejected)", passed: r.answer === NEUTRAL, detail: r.answer.slice(0, 50) },
        { name: "No validated citations", passed: r.validatedCitations.length === 0, detail: r.validatedCitations.join(", ") },
        { name: "No model_error (was a valid LLM response)", passed: r.modelError === null, detail: r.modelError ?? "null" },
      ],
    ),
  );

  // 7. Valid answer with correct citations
  results.push(
    runFixtureTest(
      "Valid answer with correct citations passes",
      fixtureValidAnswer(
        "On 14 August, the SGD to IDR payout corridor was disrupted. [[CONF-ENG-001]] PAY-101 and PAY-102 are Done. [[JIRA-PAY-101]] [[JIRA-PAY-102]]",
      ),
      "daniel",
      "What happened with the Indonesia payouts in August?",
      (r) => [
        { name: "No model_error", passed: r.modelError === null, detail: r.modelError ?? "null" },
        { name: "No citation_validation_error", passed: r.citationValidationError === null, detail: r.citationValidationError ?? "null" },
        { name: "Validated citations include CONF-ENG-001", passed: r.validatedCitations.includes("CONF-ENG-001"), detail: r.validatedCitations.join(", ") },
        { name: "Validated citations include JIRA-PAY-101", passed: r.validatedCitations.includes("JIRA-PAY-101"), detail: r.validatedCitations.join(", ") },
        { name: "Answer is substantive", passed: r.answer !== NEUTRAL, detail: r.answer.slice(0, 50) },
      ],
    ),
  );

  // Print results
  let totalPassed = 0;
  let totalFailed = 0;
  for (const r of results) {
    const status = r.status === "PASS" ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.name}`);
    for (const c of r.checks) {
      console.log(`  ${c.passed ? "+" : "X"} ${c.name}: ${c.detail}`);
    }
    console.log("");
    if (r.status === "PASS") totalPassed++;
    else totalFailed++;
  }
  console.log(`\n=== Summary: ${totalPassed} passed, ${totalFailed} failed (out of ${results.length}) ===`);
}

main().catch(console.error);
