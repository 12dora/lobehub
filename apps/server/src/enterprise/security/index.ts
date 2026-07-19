/**
 * Enterprise security primitives (M13 subset for M07/M09/M11 consumers).
 *
 * - secret/     PlatformSecretService (envelope encryption)
 * - redaction/  unified log/audit redaction entry (M01 fact source)
 * - outboundHttp/ SafeOutboundHttpClient (SSRF, G-07)
 *
 * No tRPC routes are mounted here — consumer modules wire as needed.
 */
export * from './outboundHttp';
export * from './policy';
export * from './redaction';
export * from './secret';
