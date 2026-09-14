// requires: configured test cluster with lab-transfer-fixture-v1
// produces: independent belt and inventory state assertions across one transfer
// does not: replace failure-path or rollback fixtures
import { runFixture } from "../lib/run-fixture.mjs";
import { createCase as inventory } from "../inventory-item-state/case.mjs";
import { createCase as belt } from "../belt-item-state/case.mjs";

await runFixture("itemstate", [inventory, belt]);
