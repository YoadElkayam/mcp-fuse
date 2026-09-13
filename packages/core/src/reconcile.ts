/**
 * Reconciliation verdicts (SEP 4.3): the four-valued answer to "did this effect
 * land?", with "could not determine" terminal for automatic handling — it is
 * never collapsed into "absent", and a failed read is not evidence of absence.
 */
export type ReconcileVerdict =
  | "found_once"
  | "authoritatively_absent"
  | "found_multiple"
  | "could_not_determine";

/**
 * Interpret an effect count reported by a declared reconciliation read.
 * Anything that is not a clean non-negative number is could_not_determine:
 * a missing field, a parse failure, or a nonsense value is a failed read,
 * never proof of absence.
 */
export function interpretEffectCount(raw: unknown): ReconcileVerdict {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return "could_not_determine";
  if (n === 0) return "authoritatively_absent";
  if (n === 1) return "found_once";
  return "found_multiple";
}

/** Declaration of which read answers "did this land?" for a tool, and how to
 * read the answer. Source: proxy config, or the tool's own `_meta`. */
export interface ReconcileDeclaration {
  /** Name of the read-only tool to invoke. */
  tool: string;
  /** Maps the reconcile tool's argument names to argument names of the failed
   * call, e.g. { "orderId": "orderId" }. */
  args?: Record<string, string>;
  /** Field in the read's JSON response holding the effect count. */
  countField: string;
}
