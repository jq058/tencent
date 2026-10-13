// Server-only data loader.
//
// This module provides read access to the working copy of documents
// and users. The working copy is initialized from seed.json at
// startup and can be mutated by operator commands (E01, E02, reset)
// via the workstore module.
//
// The original seed.json file under src/server-data/ is never modified.

import type { SeedData, SeedUser, SeedDocument } from "./types";
import {
  getWorkingData,
  getWorkingUsers,
  getWorkingDocuments,
  getWorkingUserById,
  getWorkingDocumentById,
} from "./workstore";

export function getSeedData(): SeedData {
  return getWorkingData();
}

export function getSeedUsers(): SeedUser[] {
  return getWorkingUsers();
}

export function getSeedDocuments(): SeedDocument[] {
  return getWorkingDocuments();
}

export function getUserById(id: string): SeedUser | null {
  return getWorkingUserById(id);
}

export function getDocumentById(id: string): SeedDocument | null {
  return getWorkingDocumentById(id);
}
