# Connector governance residuals (二开)

## 2026-07-24

- **C2 fail-closed without `unavailable`:** On governance read failure with no trustworthy LKG, resolver returns `DENIED_CONNECTOR_GOVERNANCE` — the same shape upstream already enforces (`active: true`, every known builtin API `disabled`, non-null synthetic shared-auth owner). No custom `unavailable` flag (upstream ignored it and fell open).
- **No synthetic epoch cache:** Policy is never cached or LKG-stored under an `unavailable` epoch; epoch read failure serves a live resolve without caching.
