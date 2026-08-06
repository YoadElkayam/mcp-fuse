import assert from "node:assert/strict";
import { test } from "node:test";
import { makeScenarios, SCENARIO_NAMES } from "./scenarios.js";

const scenarios = makeScenarios({ hardDownWindowMs: 30_000 });

test("scenarios are deterministic: same inputs, same outcome", () => {
  for (const name of SCENARIO_NAMES) {
    const a = scenarios[name](3, 5000);
    const b = scenarios[name](3, 5000);
    assert.deepEqual(a, b, `${name} must be a pure function`);
  }
});

test("rate-limit-storm: exactly three 429s, then recovery", () => {
  for (const i of [1, 2, 3]) {
    const outcome = scenarios["rate-limit-storm"](i, 0);
    assert.equal(outcome.kind, "error");
    assert.match(outcome.errorText!, /429 Too Many Requests/);
    assert.match(outcome.errorText!, /retry-after: 12/);
  }
  assert.equal(scenarios["rate-limit-storm"](4, 0).kind, "success");
});

test("hard-down: fails inside the window, recovers after", () => {
  assert.equal(scenarios["hard-down"](1, 0).kind, "error");
  assert.match(scenarios["hard-down"](5, 29_999).errorText!, /ECONNREFUSED/);
  assert.equal(scenarios["hard-down"](6, 30_000).kind, "success");
});

test("flapping: odd calls fail with 503, even calls succeed", () => {
  assert.equal(scenarios.flapping(1, 0).kind, "error");
  assert.match(scenarios.flapping(1, 0).errorText!, /503 Service Unavailable/);
  assert.equal(scenarios.flapping(2, 0).kind, "success");
  assert.equal(scenarios.flapping(7, 0).kind, "error");
});

test("slow-degrade: latency ramps, then long-delay 504s", () => {
  assert.deepEqual(scenarios["slow-degrade"](1, 0), { kind: "success", delayMs: 2000 });
  assert.deepEqual(scenarios["slow-degrade"](3, 0), { kind: "success", delayMs: 6000 });
  const late = scenarios["slow-degrade"](4, 0);
  assert.equal(late.kind, "error");
  assert.equal(late.delayMs, 10_000);
  assert.match(late.errorText!, /504 Gateway Timeout/);
});

test("stable: always succeeds", () => {
  for (const i of [1, 10, 100]) {
    assert.equal(scenarios.stable(i, 0).kind, "success");
  }
});

test("error payloads are realistically verbose (the token-waste being measured)", () => {
  const samples = [
    scenarios["rate-limit-storm"](1, 0),
    scenarios["hard-down"](1, 0),
    scenarios.flapping(1, 0),
    scenarios["slow-degrade"](4, 0),
  ];
  for (const outcome of samples) {
    assert.ok(
      Buffer.byteLength(outcome.errorText!) >= 300,
      `error payload should be ≥300 bytes, got ${Buffer.byteLength(outcome.errorText!)}`,
    );
  }
});
