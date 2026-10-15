// Run remaining tests T05, T11-T15 after server restart
import * as fs from "node:fs";

const expectedResults = JSON.parse(
  fs.readFileSync(
    "c:/Tencent Hackathon/internal-brain-starter-data/internal-brain-starter-data/expected-results.json",
    "utf-8",
  ),
);

const remaining = ["T05", "T11", "T12", "T13", "T14", "T15"];
const tests = expectedResults.tests.filter((t: any) => remaining.includes(t.id));

const PERMITTED: Record<string, string[]> = {
  daniel: ["CONF-ENG-001", "CONF-ENG-002", "CONF-GEN-001", "CONF-GEN-002", "JIRA-PAY-101", "JIRA-PAY-102", "JIRA-PAY-103", "SLACK-ENG-001", "SLACK-ENG-002"],
  priya: ["CONF-GEN-001", "CONF-GEN-002", "DRIVE-COMP-001", "DRIVE-COMP-002", "DRIVE-COMP-003"],
  marcus: ["CONF-GEN-001", "CONF-GEN-002"],
};
const NEUTRAL = "I couldn't find information in the sources available to you.";

let passed = 0;
let failed = 0;
let blocked = 0;

for (const testCase of tests) {
  try {
    const res = await fetch("http://localhost:3000/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-demo-user": testCase.user_id },
      body: JSON.stringify({ query: testCase.query }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.log(`[FAIL-HTTP] ${testCase.id}: HTTP ${res.status}`);
      failed++;
      continue;
    }
    const data = await res.json();
    const isNeutralTest = !!testCase.expected.exact_response;
    const checks: { name: string; passed: boolean; detail: string }[] = [];

    if (data.model_error) {
      checks.push({ name: "Model connection", passed: false, detail: String(data.model_error).slice(0, 100) });
    }

    const permitted = new Set(PERMITTED[testCase.user_id] ?? []);
    const contextIds = data.model_context_document_ids ?? [];
    checks.push({
      name: "Model context only contains permitted documents",
      passed: contextIds.every((id: string) => permitted.has(id)),
      detail: `Context: [${contextIds.join(", ")}]`,
    });

    if (data.citation_validation_error) {
      checks.push({ name: "Citation validation", passed: false, detail: String(data.citation_validation_error).slice(0, 100) });
    }

    if (isNeutralTest) {
      const matches = data.answer.trim() === testCase.expected.exact_response!.trim();
      checks.push({ name: "Exact neutral response", passed: matches, detail: matches ? "Correct" : `Got: "${data.answer.slice(0, 60)}..."` });
      if (testCase.expected.forbidden_literals) {
        const found = testCase.expected.forbidden_literals.filter((lit: string) => data.answer.toLowerCase().includes(lit.toLowerCase()));
        checks.push({ name: "No forbidden literals", passed: found.length === 0, detail: found.length === 0 ? "Clean" : `Found: [${found.join(",")}]` });
      }
    } else {
      if (testCase.expected.required_citation_groups) {
        const citationIds = new Set(data.citations.map((c: any) => c.document_id));
        const missing = testCase.expected.required_citation_groups.filter((g: string[]) => !g.some((id) => citationIds.has(id)));
        checks.push({ name: "Required citation groups", passed: missing.length === 0, detail: missing.length === 0 ? "All present" : `Missing: ${missing.map((g: string[]) => "[" + g.join("|") + "]").join(" ")}]` });
      }
      if (testCase.expected.forbidden_literals) {
        const found = testCase.expected.forbidden_literals.filter((lit: string) => data.answer.toLowerCase().includes(lit.toLowerCase()));
        checks.push({ name: "No forbidden literals", passed: found.length === 0, detail: found.length === 0 ? "Clean" : `Found: [${found.join(",")}]` });
      }
      if (data.model_error) {
        console.log(`[BLOCKED] ${testCase.id}: model_error`);
        for (const c of checks) console.log(`  ${c.passed ? "+" : "X"} ${c.name}: ${c.detail}`);
        console.log(`  Answer: "${(data.answer || "").slice(0, 100)}..."`);
        blocked++;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (!data.model_configured) {
        console.log(`[BLOCKED] ${testCase.id}: not configured`);
        blocked++;
        continue;
      }
      const isNeutral = data.answer.trim() === NEUTRAL;
      checks.push({ name: "Positive answer (not neutral)", passed: !isNeutral, detail: isNeutral ? "Neutral fallback" : "Substantive" });
    }

    const allPassed = checks.every((c) => c.passed);
    const status = allPassed ? "PASS" : "FAIL";
    console.log(`[${status}] ${testCase.id}`);
    for (const c of checks) console.log(`  ${c.passed ? "+" : "X"} ${c.name}: ${c.detail}`);
    console.log(`  Answer: "${(data.answer || "").slice(0, 120)}..."`);
    console.log(`  Citations: [${(data.citations || []).map((c: any) => c.document_id).join(", ")}]`);
    if (data.model_error) console.log(`  Model error: ${String(data.model_error).slice(0, 80)}`);

    if (allPassed) passed++;
    else failed++;
  } catch (err) {
    console.log(`[BLOCKED] ${testCase.id}: ${err instanceof Error ? err.message : String(err)}`);
    blocked++;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.log(`\n=== Remaining tests: ${passed} passed, ${failed} failed, ${blocked} blocked ===`);
