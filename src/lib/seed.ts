// Server-only seed data loader.
//
// This module provides access to the working store (mutable copies
// of documents and users). All read accessors delegate to workstore.ts
// so that document updates, access revocation, and resets are visible
// across the application.
//
// The original seed file lives under src/server-data/ and is never
// imported into any client component or bundle.

import type { SeedData } from "./types";
import {
  getWorkingDocuments,
  getWorkingUsers,
  getWorkingDocumentById,
  getWorkingUserById,
  getOriginalSeedData,
} from "./workstore";

export function getSeedData(): SeedData {
  // Return original seed data (immutable baseline). Use this only for
  // reference, not for live document/user access.
  return getOriginalSeedData();
}

export function getSeedUsers(): SeedData["users"] {
  return getWorkingUsers();
}

export function getSeedDocuments(): SeedData["documents"] {
  return getWorkingDocuments();
}

export function getUserById(id: string) {
  return getWorkingUserById(id);
}

export function getDocumentById(id: string) {
  return getWorkingDocumentById(id);
}
