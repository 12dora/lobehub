/**
 * `nerdamer-prime` ships typings for its root entry only; the `all` subpath (root plus the
 * algebra / calculus / solve add-ons, which is what the executor lazy-imports) has none, so
 * without this the dynamic import is an implicit `any` error under `noImplicitAny`.
 *
 * The executor already treats the module as `any` — it only calls it as a parser function —
 * so re-exporting the root typings would buy nothing over a plain module declaration.
 */
declare module 'nerdamer-prime/all';
