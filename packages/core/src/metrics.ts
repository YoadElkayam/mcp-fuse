/** Counters behind the ROI story: what the fuse absorbed on the agent's behalf. */
export class FuseMetrics {
  retriesAbsorbed = 0;
  circuitsOpened = 0;
  errorsSuppressed = 0;
  /** Total bytes of raw error text kept out of the context window. */
  suppressedErrorBytes = 0;

  recordAbsorbedRetry(): void {
    this.retriesAbsorbed += 1;
  }

  recordSuppressedError(rawErrorText: string): void {
    this.errorsSuppressed += 1;
    this.suppressedErrorBytes += Buffer.byteLength(rawErrorText, "utf8");
  }

  recordCircuitOpened(): void {
    this.circuitsOpened += 1;
  }

  /** Rough tokens-saved estimate (~4 bytes/token). Clearly labeled an estimate. */
  estimatedTokensSaved(): number {
    return Math.round(this.suppressedErrorBytes / 4);
  }

  summary(): string {
    return (
      `mcp-fuse: absorbed ${this.retriesAbsorbed} retries, ` +
      `opened ${this.circuitsOpened} circuit(s), ` +
      `suppressed ${this.errorsSuppressed} agent-visible errors ` +
      `(~${this.estimatedTokensSaved()} tokens of error payload kept out of context)`
    );
  }
}
