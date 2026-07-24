| Finding | Verified Sev | Fix status | Note                                                                                                                                                  |
| ------- | ------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1      | HIGH         | FIXED\_OK  | Alibaba IMDS is permanently denied across policy modes, including mapped IPv6 and resolved-IP paths; Tencent coverage was also added.                 |
| F2      | MEDIUM       | FIXED\_OK  | Write-path redaction now checks the shared PEM, AWS, and Google patterns, with full and truncated-PEM regression coverage.                            |
| F3      | MEDIUM       | FIXED\_OK  | All documented GitHub token families are covered by shared detection/masking patterns and behavioral tests.                                           |
| F4      | MEDIUM       | PARTIAL    | `get`, `list`, and `cancel` are Vault-independent, but `retry` still invokes the Vault-backed factory even though coordinator retry is database-only. |
| F5      | MEDIUM       | FIXED\_OK  | Malformed query-key encoding is guarded and fail-closed, masking the associated value without throwing.                                               |
| F6      | LOW          | FIXED\_OK  | Exact-limit bodies remain untruncated; overflow is detected only upon receiving an additional byte.                                                   |
| F7      | LOW          | FIXED\_OK  | Window expiry is SQL-controlled, lock state is synchronized explicitly, and cleanup deletion plus batch bounds are asserted.                          |
| F8      | LOW          | FIXED\_OK  | The inert placeholder catalog, suppression expression, and source-text assertion were removed.                                                        |
| F9      | LOW          | FIXED\_OK  | Documentation now matches the `public-only` default and production fail-closed handling of limiter unavailability.                                    |

VERDICT: needs-rework

- F4 — Route `retry` through the DB-only coordinator and add a Vault-unavailable retry regression test, since retry itself performs no cryptographic/provider operation.
