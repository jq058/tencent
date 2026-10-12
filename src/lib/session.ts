// Demo session management.
//
// This is a LOCAL DEMONSTRATION feature, not production authentication.
// The demo session is an explicit server-side mapping from a demo token
// to a seed user ID. The browser sends only the demo token; it cannot
// supply roles, user IDs, or document permissions.
//
// In a production system this would be replaced by a real authentication
// provider (OIDC, SAML, etc.) that resolves identity from a verified
// session. The permission checks in `permissions.ts` would remain the same.

import { getUserById } from "./seed";
import type { DemoUser } from "./types";

export const DEMO_LABEL =
  "Local demonstration only — not production authentication";

// The three demo identities allowed in the selector.
const DEMO_USER_IDS = ["daniel", "priya", "marcus"] as const;

export function getDemoUserIds(): readonly string[] {
  return DEMO_USER_IDS;
}

/**
 * Resolves a demo session token to a demo user.
 * Returns null for unknown or missing tokens. The browser cannot
 * inject a role or user ID — only the pre-defined demo token is accepted.
 */
export function resolveSession(
  demoUserId: string | null | undefined,
): { user: DemoUser | null } {
  if (!demoUserId) return { user: null };

  if (!DEMO_USER_IDS.includes(demoUserId as (typeof DEMO_USER_IDS)[number])) {
    return { user: null };
  }

  const seedUser = getUserById(demoUserId);
  if (!seedUser) return { user: null };

  return {
    user: {
      id: seedUser.id,
      display_name: seedUser.display_name,
      role: seedUser.role,
    },
  };
}
