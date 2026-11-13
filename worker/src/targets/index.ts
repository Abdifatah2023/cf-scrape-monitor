import { books } from "./books";
import type { Target } from "./types";

export const TARGETS: Target[] = [books];

export function getTarget(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}
