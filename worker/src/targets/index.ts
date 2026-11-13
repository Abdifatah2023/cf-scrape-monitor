import { books } from "./books";
import { quotes } from "./quotes";
import type { Target } from "./types";

/** Every target the scraper knows. A target also has to be enabled in the D1 `targets` table. */
export const TARGETS: Target[] = [books, quotes];

export function getTarget(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}
