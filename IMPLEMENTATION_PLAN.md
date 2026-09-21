# Jev Pong implementation

Build a playable, approachable first-to-seven arcade match that makes structured Jev decisions visible. The supplied document is the product brief; secrets remain server-only and all model/mock/fallback sources are explicit.

- [x] Inspect empty workspace; extract brief; verify official documentation.
- [x] Scaffold Next.js, TypeScript, local fonts, lint, formatting and test tools.
- [x] Implement deterministic Pong and confidence/staleness policy.
- [x] Implement validated official Jev endpoint with the official SDK and deterministic mock scenarios.
- [x] Build responsive Canvas arcade, input, pause, rematch and restrained sound.
- [x] Add decision monitor, inspectable history, session metrics and JSON export.
- [x] Verify unit/integration/browser tests, typecheck, lint, format and production build.
- [x] Open playable local demo and document setup and verification limits.
- [ ] Verify the official live provider using a real TypeSafe credential and complete a live match. Implementation is ready; this external verification remains pending.

Design: charcoal #10120f, surface #191c17, warm white #eeefe5, moss grey #8c9585, signal lime #c4f46e and arcade orange #ff8a4c. Space Grotesk for interface and restrained display lettering; IBM Plex Mono for telemetry. The signature is a full playable court paired with an instrument-like decision monitor, with a dotted centerline echoed in the logo. Dark green is confined to the arena and signal areas. No stock imagery. Sound begins muted and can be enabled with one button; decorative effects respect reduced motion.

Independent workstreams: game engine and policy, provider/API integration, telemetry and documentation, and UI/runtime orchestration. Live-provider verification depends on a locally configured TypeSafe credential; do not claim live verification from mock tests.

Verification on September 21, 2026: 82 unit/integration tests passed, one opt-in live test skipped; 15 desktop/mobile browser tests passed, one desktop touch-only test skipped. Formatting, ESLint, TypeScript and production build passed. Real mock API requests passed in the browser. A build-only canary credential was absent from all 11 client JavaScript chunks; SDK/provider code and credential access were also absent.
