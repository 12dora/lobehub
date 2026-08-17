# Browser device profiles

`BrowserDeviceProfile` is the shared, isomorphic description of one synthetic desktop Chrome
installation. A profile is generated deterministically from an installation seed, validated as a
coherent UA / client-hint / operating-system / screen / locale bundle, persisted by the server,
and reused by every browser-impersonating transport.

Use `generateBrowserDeviceProfile()` only when creating or intentionally refreshing a profile.
Normal consumers receive the persisted profile and build browser-shaped headers with
`userAgentHeaders()`, `buildClientHintHeaders()`, and `buildFetchMetadataHeaders()`.

The fallback profile is derived from `DEFAULT_BROWSER_DEVICE_PROFILE_SEED`; it contains no facts
from the host machine. Timezone offsets are deliberately stored as standard offsets, not live
DST-adjusted values.
