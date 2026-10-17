import type { CtlPluginContext } from "@clusterio/ctl";
import { Command, CommandTree, EventSubscriber } from "@clusterio/lib";
import * as messages from "./messages.js";

type ControlLike = {
	sendTo: <T = unknown>(target: string, message: unknown) => Promise<T>;
};

type YargsLike = { option: (name: string, opts: unknown) => YargsLike };

const watchOption = (yargs: YargsLike) => {
	yargs.option("watch", { type: "boolean", default: false, describe: "Keep printing each cluster pause state change until interrupted" });
};

export async function watchState(control: ControlLike, print: (line: string) => void = line => console.log(line),
	until: Promise<unknown> = new Promise(resolve => process.once("SIGINT", resolve))) {
	const subscriber = new EventSubscriber(messages.ClusterPauseStateEvent, control as never);
	const unsubscribe = subscriber.subscribe(event => {
		if (event) print(JSON.stringify(event));
	});
	try { await until; }
	finally { unsubscribe(); }
}

export const clusterPauseCommands = new CommandTree({
	name: "cluster-pause",
	description: "Cluster pause plugin commands",
});

clusterPauseCommands.add(new Command({
	definition: ["status", "Show the phase, online players, holds and paused instances (JSON)", watchOption],
	handler: async (args: { watch?: boolean }, control: ControlLike) => {
		console.log(JSON.stringify(await control.sendTo("controller", new messages.ClusterPauseStatusRequest()), null, 2));
		if (args.watch) await watchState(control);
	},
}));

for (const [action, description] of [
	["pause", "Start draining now, skipping the countdown; refused while anyone is online or an instance state is unknown"],
	["resume", "Cancel the countdown or draining, or unpause every instance"],
] as const) {
	clusterPauseCommands.add(new Command({
		definition: [action, description, watchOption],
		handler: async (args: { watch?: boolean }, control: ControlLike) => {
			console.log(JSON.stringify(await control.sendTo("controller", new messages.ClusterPauseControlRequest({ action })), null, 2));
			if (args.watch) await watchState(control);
		},
	}));
}

export function addCommands(rootCommand: CommandTree): void {
	rootCommand.add(clusterPauseCommands);
}

export default async function loadCtlPlugin(context: CtlPluginContext) {
	context.hooks.addCommands.attach(context.plugin.name, addCommands);
}
