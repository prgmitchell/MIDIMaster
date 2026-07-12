# ADR-001: First-party Plugin Store Trust Model

## Status

Accepted for the next Store-capable MIDIMaster release.

## Context

Plugin packages execute JavaScript in MIDIMaster's main WebView. Signing proves that a package was published through the official Store, but it does not isolate the plugin from the runtime bridge.

## Decision

The initial Store publishes only first-party plugins reviewed and controlled by MIDIMaster. Every Store release is signed, immutable, versioned with SemVer, and declares its minimum compatible app version.

## Consequences

- Users can verify publisher integrity and receive safe compatibility/update behavior.
- Community submissions remain disabled.
- A future third-party Store requires an explicit permission model, runtime restrictions, identity/revocation, and review tooling before this decision is revisited.
