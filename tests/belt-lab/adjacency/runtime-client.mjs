import { requireLuaSuccess } from "./lab-safety.mjs";

export class RuntimeClient {
	#ownsPause = false;
	#transport;

	constructor({ transport }) {
		if (typeof transport !== "function") throw new TypeError("RuntimeClient requires a transport function");
		this.#transport = transport;
	}

	get ownsPause() {
		return this.#ownsPause;
	}

	async call(operation, payload = {}) {
		return requireLuaSuccess(await this.#transport(operation, payload), operation);
	}

	async beginOwnedPause() {
		if (this.#ownsPause) throw new Error("pause ownership already acquired");
		const before = await this.call("inspect");
		if (before.gamePaused) throw new Error("game is already paused; refusing pause ownership");
		await this.call("set_pause", { expectedCurrent: false, paused: true });
		// The Lua operation asserts the write stuck before returning success. From this point onward
		// cleanup owns the pause even if the independent readback transport flakes.
		this.#ownsPause = true;
		const after = await this.call("inspect");
		if (after.gamePaused !== true) throw new Error("pause readback did not become true");
		return after;
	}

	async endOwnedPause() {
		if (!this.#ownsPause) return null;
		await this.call("set_pause", { expectedCurrent: true, paused: false });
		this.#ownsPause = false;
		const after = await this.call("inspect");
		if (after.gamePaused !== false) throw new Error("pause readback did not become false");
		return after;
	}
}
