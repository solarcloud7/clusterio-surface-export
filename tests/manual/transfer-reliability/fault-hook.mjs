// Loaded only into disposable host containers through NODE_OPTIONS=--import. Never shipped in the plugin.
// requires: SE_MANUAL_RUN naming a disposable lab run; Node 22+ (module.register); the plugin's ES-module instance entrypoint
// produces: a module load hook that appends the manual fault patch to the plugin's instance entrypoint as it is imported
// does not: touch any module other than the instance entrypoint, hold a reply on its own (fault-hook-patch.mjs does, under the rule file), or run outside a container whose run identity it can verify
import { register } from "node:module";

const run = process.env.SE_MANUAL_RUN;
if (!/^se-manual-[a-z0-9-]{8,60}$/.test(run || "")) throw new Error("Manual fault hook requires disposable run identity");
register("./fault-hook-loader.mjs", import.meta.url);
