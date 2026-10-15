// Shared test type definitions used by test runner scripts.

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FixtureTestResult {
  name: string;
  status: "PASS" | "FAIL";
  checks: CheckResult[];
}
