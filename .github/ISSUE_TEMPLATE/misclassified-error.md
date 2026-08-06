---
name: Misclassified error
about: An error string got the wrong category (or landed in `unknown`) — the single most valuable contribution
title: "classifier: "
labels: ["classifier-corpus", "good first issue"]
---

**The raw error text** (paste it verbatim — this becomes a test case):

```
<paste here>
```

**Which MCP server produced it:**

**What category it currently gets** (run with `--verbose` or check the JSONL log):

**What category it should get** (`transient` / `rate_limit` / `timeout` / `auth` / `permission` / `invalid_input` / `not_found` / `resource_exhausted` / `permanent`):

Want to fix it yourself? Add the text as a test case in
`packages/core/src/core.test.ts`, adjust the rules in
`packages/core/src/classifier.ts`, and open a PR. See CONTRIBUTING.md.
