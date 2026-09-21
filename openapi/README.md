# OpenAPI contracts

- `jev-api.gateway.openapi.json` is the recommended gateway import. It contains
  no `$ref`, reusable `components/schemas`, or schema composition, for
  compatibility with gateway importers that support only basic OpenAPI schemas.
  It declares only the Fabric `X-Gateway-key` credential. Fabric handles
  upstream TypeSafe authentication, so clients do not send a Bearer credential
  to the Gateway. Do not expose the Gateway key to browser clients. Its `state`
  schema is intentionally constrained to the object form used by Jev Pong.
- `jev-api.openapi.yaml` is the complete, standards-valid contract for the
  official upstream TypeSafe Jev API at `https://api.typesafe.ai`. It retains
  reusable components, explicit question/answer variants, and Bearer security
  metadata for OpenAPI tooling that supports the full OpenAPI 3.0 feature set.
- `jev-pong-api.openapi.yaml` describes the two server endpoints exposed by this
  application. Replace its local `servers[0].url` with the deployed Jev Pong
  origin before importing it into a remote gateway.

The official Jev API currently documents one HTTP operation:
`POST /v1/systemone`. The Jev Pong façade exposes `GET /api/agent/config` and
`POST /api/agent/decide`.
