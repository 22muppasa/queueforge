# Security model

## Supported use

The supplied Compose configuration is a localhost-only engineering demo. It has no end-user authentication or tenant authorization and must not be exposed directly to an untrusted network.

Report vulnerabilities privately to the repository owner rather than placing secrets or exploitable details in a public issue.

## Trust boundaries

- API clients are untrusted input sources.
- Handler implementations are trusted application code chosen from a compile-time allowlist.
- Job payloads/results/errors may contain sensitive business data and require an organizational classification/retention policy before production use.
- PostgreSQL is the durability and serialization trust anchor.
- The dashboard is an operator surface; its mutation actions require real authorization before deployment.
- Idempotency keys are bearer-like correlation material and are hashed at rest, but should still be generated with high entropy and not logged.

## Existing controls

- Strict request and handler schemas, safe name patterns, numeric bounds, one-year schedule horizon, and 256 KiB body limit.
- No arbitrary imports, source, shell commands, or function names.
- Lease token excluded from public APIs.
- Error type/message truncation.
- Metric labels exclude job/client/key/payload/error values.
- API and PostgreSQL host ports bind to `127.0.0.1`.
- Application container uses a nonroot user.
- Current backend and dashboard dependency audits are clean at delivery.
- Idempotency keys are stored as SHA-256 hashes.

## Required before public deployment

- Strong identity, per-tenant authorization, operator roles, CSRF protections as appropriate, and authenticated SSE.
- Edge TLS, security headers, strict CORS, network policies, database private networking, and secret rotation.
- Per-principal submission/read/cancel/redrive rate limits and quotas.
- Payload/result/error schema-level sensitive-field policy, log redaction, encryption, and retention/erasure workflow.
- Audit logs for operator access and mutations, stored separately from mutable application logs.
- PostgreSQL least-privilege roles rather than one application owner credential.
- Supply-chain scanning, signed images, locked CI provenance, SBOMs, and patch policy.
- Denial-of-service controls for expensive dashboard aggregates and SSE clients.
- Handler egress allowlists/timeouts and downstream idempotency credentials.

## Known limitations

- `X-Client-Id` is only a namespace, not authenticated identity.
- CORS defaults to `*` inside the local stack.
- Local sample credentials are committed by design and must never be reused.
- A SHA-256 key hash protects disclosure but not low-entropy key guessing; use random keys.
- Application-level handler effects are not protected by the queue lease once they cross into another system. Use downstream idempotency, a transactionally coupled outbox/inbox, or an accepted fencing generation.
- Results and job history do not yet have automatic retention.
