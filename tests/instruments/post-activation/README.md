# Activation cargo audit

Manual, bounded Factorio 2.1.17 probe; not another full CI transfer pipeline.
Run `node tests/instruments/post-activation/run-tests.mjs` from the canonical checkout.

Invariant: the production activation helper preserves already-restored cargo within the same
callback. Fixture: one chest, two inserters (one to activate, one to leave inactive), and one
water tank. Independent reads use the chest's item count, explicit held-stack fields and the
tank's fluid count. A missing held stack is the negative control for the earlier cargo counter.
This does not certify all entity types or full transfers.

No game pause, other surfaces, source deletion, spill/recovery assistance or settings changes.
Refuse active leases and connected players. Stop on any construction, read or invariant failure.
Two fixture callbacks (injected construction failure, normal run) and two independent deletion
checks; each payload is under 8 KB. Surface deletion is queued by Factorio, so absence is checked
after the callback returns. The existing RCON helper supplies the transport timeout.

`observe.lua` uses the pinned runtime API: surface creation/tile writes/entity creation,
entity inventory and fluid counts, inserter held stacks and `disabled_by_script`, and queued
surface deletion. The runner verifies the engine version. The observer, runner and relevant
checkout modules are hashed into `ci-artifacts/post-activation-live.json`; cleanup proof is
recorded there. No production module replacement occurs.

An initial harness incorrectly expected immediate surface deletion. Independent inspection
confirmed deletion; the corrected runner checks the documented queued boundary. That first
harness result is not evidence of cargo behavior.
