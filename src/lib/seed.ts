// Server-only seed data loader.
// This module reads seed.json from disk at startup and caches it.
// The seed file lives under src/server-data/ and is never imported
// into any client component or bundle.

import type { SeedData } from "./types";

import seedJson from "../server-data/seed.json";

const seedData = seedJson as unknown as SeedData;

// Build lookup maps once at module load.
const usersById = new Map(seedData.users.map((u) => [u.id, u]));
const documentsById = new Map(seedData.documents.map((d) => [d.id, d]));

export function getSeedData(): SeedData {
  return seedData;
}

export function getSeedUsers(): SeedData["users"] {
  return seedData.users;
}

export function getSeedDocuments(): SeedData["documents"] {
  return seedData.documents;
}

export function getUserById(id: string) {
  return usersById.get(id) ?? null;
}

export function getDocumentById(id: string) {
  return documentsById.get(id) ?? null;
}
