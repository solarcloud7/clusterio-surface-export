# Shared integration helpers

`TestBase.psm1` provides RCON calls, current platform lookup, optional fixture
cloning, diagnostic reads and assertions. It does not make every test isolated:
the caller owns its setup, world mutations and cleanup.

`Step-Tick` sends `/step-tick`. The current Lua handler unpauses the game and
ignores the requested count; it neither calls `Start-Sleep` nor proves an exact
tick wait. Observe the intended job/phase or advancing ticks with a bounded poll.
This helper limitation is separate from transfer correctness.

Names are fixture lookup hints, not persistent transfer identity. A clone uses
the product's serialization/restoration path and cannot independently prove that
same path correct. Keep independent physical checks and fixture-owned cleanup.

See [test selection and examples](../../../docs/developers/testing.md) and
[fixtures](../../../docs/developers/fixtures.md). The module's exported functions
define its current callable interface.
