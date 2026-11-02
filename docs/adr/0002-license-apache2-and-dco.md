# ADR-0002: Apache-2.0 license with DCO sign-off (no CLA)

- Status: Accepted
- Date: 2026-11-02

## Context
The project must allow commercial use, modification, and redistribution, and attract both community and vendor contributors.

## Decision
1. License the project under **Apache License 2.0**.
2. Contributors certify origin with the **Developer Certificate of Origin 1.1** (`Signed-off-by:` on each commit), enforced by a GitHub DCO check. **No CLA.**

## Rationale: Apache-2.0 vs. MIT
Both are permissive and allow commercial use. Apache-2.0 adds an **express patent license** from contributors and a **patent-retaliation** clause, explicit contribution terms (§5), and a NOTICE mechanism. For a domain with active patents (color, screening, nesting), the patent grant matters. MIT is shorter, but silent on patents.

## Rationale: DCO vs. CLA
- A **CLA** (especially copyright assignment or a broad license grant to the maintainer) would let BAX Forward **relicense later** (e.g. dual-license or move to a different license) without contacting every contributor. That's its main advantage.
- Costs of a CLA: friction for contributors (corporate legal review), a perception of a possible future "rug-pull", and admin overhead.
- The **DCO** is lightweight and widely used (Linux kernel, CNCF projects). Combined with Apache-2.0 §5, inbound contributions = outbound license. Apache-2.0 already allows BAX Forward and anyone else to ship proprietary products built on it, so relicensing is rarely needed.

**Recommendation: DCO.** We accept that relicensing the existing code would later need contributor consent. Revisit only through a new ADR.

## Consequences
+ Low contribution friction and a vendor-friendly patent grant.
− No unilateral relicensing.
