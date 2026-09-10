# Shared SEP draft: structured error policy for MCP

This folder is the working draft for a Specification Enhancement Proposal that grew
out of two spec discussions:

- [#3188 Should MCP standardize a retry-timing hint?](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/3188)
- [#2930 Standardize operator-friendly tool failure metadata](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2930)

It lives here only until it has a sponsor and moves to the `seps/` directory of the
specification repository. Nobody owns it; PRs from anyone in the discussions are
welcome, and section owners below are starting points, not fences.

## How to contribute

1. Open a PR against `sep/SEP-error-policy.md`. Small, focused changes merge fastest.
2. Follow the MCP org [AI contribution policy](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/AI_POLICY.md):
   if AI assistance was used for your change, say so in the PR description and to what
   extent. The final SEP submission will carry a disclosure for the whole document.
3. Keep claims backed: every number in Motivation links to its dataset or benchmark.

## Section owners (from the #3188 thread)

| Section | Owner | Source material |
|---------|-------|-----------------|
| Motivation (ecosystem data) | aurumflux20 | fencescan scan dataset, agent-money-test false-positive writeup |
| Category vocabulary, code-to-class mapping, governance case, client behavior rules | johnyzaguirre-glean | #2930 thread |
| Error policy payload: category, retry timing, circuit state, carriers | YoadElkayam | mcp-fuse `spec/` + reference implementation |
| Effect declaration (tri-state effect class) and reconciliation pointer | aurumflux20 | RETRY-CONTRACT draft |
| Operator fields (correlation id) | johnyzaguirre-glean | #2930 |
| Docs-first guidance page (pre-SEP) | johnyzaguirre-glean | |

Status note (2026-09-10): johnyzaguirre-glean's sections were drafted by the group
under the graceful-exit offered in #2930, with his thread as the source and him
credited as originator. His PRs reshaping them are welcome anytime.

## Process (per the SEP guidelines)

- Find the relevant interest or working group before submitting; the Interceptors WG
  is the natural home for this proposal.
- Submit as a PR adding one file to `seps/`, then find a sponsor from MAINTAINERS.md.
- A prototype is required: mcp-fuse is the reference implementation for the payload
  and client-side behavior; fencescan covers the declaration side.
