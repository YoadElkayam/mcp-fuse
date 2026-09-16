# Payments profile (draft)

Recommended stable `code` values for monetized MCP / x402-style tool surfaces,
after operator field reports by slowe89 in
[#2930](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2930).
Codes ride in the payload's optional `code` field; the `category` stays one of the
core enum values, so clients need no payment awareness.

| `code` | `category` (class) | The failure it separates |
|--------|--------------------|--------------------------|
| `payment_challenge_invalid` | `invalid_input` (capability) | facilitator verify rejected the challenge itself (field lengths, metadata, Unicode cliffs) and surfaced it as a bare 402: looks like "no demand / unfunded" until coded |
| `payment_required` | `resource_exhausted` (capability) | genuine unfunded / insufficient balance |
| `settlement_unconfirmed` | `unknown` (reliability) | data served without a confirmed settle (or racing the settle): client sees 200 + payload; only the code tells support "delivered without confirmed settlement" |
| `payment_header_invalid` | `invalid_input` (capability) | unparseable or unrecognized payment header: MUST be a coded failure, never a silent pass |

Two of these (`settlement_unconfirmed`, `payment_header_invalid`) are really
server-conformance defects: a server that serves without gating on settle, or that
treats a junk header as payment-OK, fails regardless of what it reports. Test
vectors for those belong in the payment-shaped battery
([hostile-facilitator](https://github.com/aurumflux20/hostile-facilitator)) rather
than the MCP-generic one here; contributions of concrete reject/settle vectors are
welcome in either place.
