// requires: configured test cluster with lab-transfer-fixture-v1
// produces: independent entity configuration assertions across one transfer
// does not: replace cargo or failure-path fixtures
import { runFixture } from "../lib/run-fixture.mjs";
import { createCase } from "./case.mjs";

await runFixture("cfgattr", [createCase]);
