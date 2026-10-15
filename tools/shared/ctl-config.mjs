// requires: the parsed JSON of a clusterioctl config file (Clusterio 2.0 writes ctl.* keys; alpha.27 wrote control.*)
// produces: the controller token and URL from whichever key the file carries, and a config object in the 2.0 layout
// does not: read files, print the token, or validate it against a controller
export const CTL_TOKEN_KEYS = ["ctl.controller_token", "control.controller_token"];
export const CTL_URL_KEYS = ["ctl.controller_url", "control.controller_url"];

function first(config, keys) {
	for (const key of keys) {
		const value = config?.[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function controllerToken(config) {
	return first(config, CTL_TOKEN_KEYS);
}

export function controllerUrl(config) {
	return first(config, CTL_URL_KEYS);
}

export function ctlConfig({ controllerUrl: url, token, maxReconnectDelay = 60 }) {
	return {
		"ctl.controller_url": url,
		"ctl.controller_token": token,
		"ctl.max_reconnect_delay": maxReconnectDelay,
	};
}
