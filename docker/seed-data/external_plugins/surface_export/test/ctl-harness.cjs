"use strict";

const path = require("node:path");
const lib = require("@clusterio/lib");
const control = require(path.join(__dirname, "..", "dist", "node", "control.js"));

function commandsOf(tree) {
	return [...tree.subCommands.values()].flatMap(node => (node instanceof lib.CommandTree ? commandsOf(node) : [node]));
}

function registeredCommands() {
	const root = new lib.CommandTree({ name: "root", description: "clusterioctl" });
	control.addCommands(root);
	return commandsOf(root).map(command => ({
		name: command.name,
		definition: command._definition,
		handler: (args, ctl) => command.run(args, ctl),
	}));
}

module.exports = { commandsOf, registeredCommands };
