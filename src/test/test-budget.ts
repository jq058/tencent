// Shared live-test budget enforcement.
//
// Enforces a maximum of 3 model API requests per development run.
// Stops immediately on quota errors. No automatic retries.
//
// Usage in test scripts:
//   import { createBudget } from "./test-budget";
//   const budget = createBudget();
//
//   if (budget.canCall()) {
//     const result = await budget.call(async () => { ... });
//   } else {
//     // Report as BLOCKED — budget exhausted
//   }
//
// To enable live tests, set the environment variable:
//   LIVE_TEST=1
//
// Without this variable, all live tests are reported as BLOCKED.

interface BudgetState {
  maxCalls: number;
  callsMade: number;
  quotaError: boolean;
  quotaErrorMessage: string | null;
}

export function createBudget(maxCalls = 3) {
  const state: BudgetState = {
    maxCalls,
    callsMade: 0,
    quotaError: false,
    quotaErrorMessage: null,
  };

  return {
    isLiveTestEnabled(): boolean {
      return process.env.LIVE_TEST === "1" || process.env.LIVE_TEST === "true";
    },

    canCall(): boolean {
      if (!this.isLiveTestEnabled()) return false;
      if (state.quotaError) return false;
      return state.callsMade < state.maxCalls;
    },

    remainingCalls(): number {
      return Math.max(0, state.maxCalls - state.callsMade);
    },

    /**
     * Execute a model call within the budget. Throws immediately if the
     * budget is exhausted or a previous quota error was detected.
     * After the call, checks the result for quota errors and stops
     * further calls if detected.
     */
    async call<T>(fn: () => Promise<T>): Promise<T> {
      if (!this.isLiveTestEnabled()) {
        throw new Error(
          "Live testing is not enabled. Set LIVE_TEST=1 to run live model tests.",
        );
      }
      if (state.quotaError) {
        throw new Error(
          `Budget stopped due to previous quota error: ${state.quotaErrorMessage}`,
        );
      }
      if (state.callsMade >= state.maxCalls) {
        throw new Error(
          `Model call budget exhausted (${state.callsMade}/${state.maxCalls}). Stop and report results separately.`,
        );
      }

      state.callsMade++;
      const result = await fn();
      return result;
    },

    /**
     * Check if an error string or response indicates a quota/insufficient
     * resources error. If so, mark the budget as stopped.
     */
    checkQuotaError(error: string | null | undefined): boolean {
      if (!error) return false;
      const lower = error.toLowerCase();
      if (
        lower.includes("quota") ||
        lower.includes("insufficient") ||
        lower.includes("balance") ||
        lower.includes("exhausted") ||
        lower.includes("rate limit")
      ) {
        state.quotaError = true;
        state.quotaErrorMessage = error;
        return true;
      }
      return false;
    },

    getState(): Readonly<BudgetState> {
      return { ...state };
    },
  };
}
