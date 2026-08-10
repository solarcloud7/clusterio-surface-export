"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
	nextLiveStatus, shouldRetryResubscribe, resubscribeDelayMs,
	RESUBSCRIBE_BASE_DELAY_MS, RESUBSCRIBE_MAX_DELAY_MS,
} = require(path.join(__dirname, "..", "dist", "node", "shared", "live-status.js"));

const webIndex = fs.readFileSync(path.join(__dirname, "..", "web", "index.tsx"), "utf8");

const base = { previous: "live", connected: true, lastEvent: "connect", outcome: null };

test("a sync that never subscribed cannot report live", () => {
	assert.equal(
		nextLiveStatus({ ...base, previous: "live", connected: false, outcome: "skipped" }),
		"reconnecting",
		"syncLiveState resolves WITHOUT subscribing when the connector is down — resolution is not proof",
	);
});

test("a disconnected connector outranks any outcome", () => {
	for (const outcome of ["subscribed", "unsubscribed", "skipped", "failed", null]) {
		assert.equal(
			nextLiveStatus({ ...base, connected: false, lastEvent: "drop", outcome }),
			"reconnecting",
			`outcome ${String(outcome)} must not claim live while disconnected`,
		);
	}
});

test("close is offline, drop is reconnecting", () => {
	assert.equal(nextLiveStatus({ ...base, connected: false, lastEvent: "close", outcome: null }), "offline");
	assert.equal(nextLiveStatus({ ...base, connected: false, lastEvent: "drop", outcome: null }), "reconnecting");
});

test("a real subscribe is the only route to live", () => {
	assert.equal(nextLiveStatus({ ...base, previous: "reconnecting", outcome: "subscribed" }), "live");
	assert.notEqual(nextLiveStatus({ ...base, previous: "reconnecting", outcome: "unsubscribed" }), "live");
	assert.notEqual(nextLiveStatus({ ...base, previous: "reconnecting", outcome: "skipped" }), "live");
	assert.notEqual(nextLiveStatus({ ...base, previous: "reconnecting", outcome: "failed" }), "live");
});

test("a page that loads while already connected does not sit at reconnecting", () => {
	assert.equal(
		nextLiveStatus({ previous: "reconnecting", connected: true, lastEvent: null, outcome: "subscribed" }),
		"live",
		"onUpdate subscribes without any connection event — that must still clear the initial reconnecting",
	);
});

test("a failed sync is degraded, and only a connected degraded retries", () => {
	assert.equal(nextLiveStatus({ ...base, outcome: "failed" }), "degraded");
	assert.equal(shouldRetryResubscribe("degraded", true), true);
	assert.equal(shouldRetryResubscribe("degraded", false), false, "no point retrying a dead socket");
	assert.equal(shouldRetryResubscribe("live", true), false);
	assert.equal(shouldRetryResubscribe("reconnecting", true), false,
		"reconnecting is the socket's job, not the subscription's");
});

test("a deliberate unsubscribe leaves the status alone", () => {
	assert.equal(nextLiveStatus({ ...base, previous: "live", outcome: "unsubscribed" }), "live");
	assert.equal(nextLiveStatus({ ...base, previous: "degraded", outcome: "unsubscribed" }), "degraded");
});

test("backoff doubles from the base and stops at the ceiling", () => {
	assert.equal(resubscribeDelayMs(0), RESUBSCRIBE_BASE_DELAY_MS);
	assert.equal(resubscribeDelayMs(1), RESUBSCRIBE_BASE_DELAY_MS * 2);
	assert.equal(resubscribeDelayMs(100), RESUBSCRIBE_MAX_DELAY_MS, "must not overflow into an eternal delay");
	assert.equal(resubscribeDelayMs(-5), RESUBSCRIBE_BASE_DELAY_MS, "a negative attempt must not shrink the delay");
});

test("every syncLiveState call site reports its outcome", () => {
	const direct = webIndex.match(/this\.syncLiveState\(\)/g) || [];
	assert.equal(direct.length, 1,
		"syncLiveState must be called in exactly one place — syncAndReport. A second raw call site is a path "
		+ "that changes the subscription without moving the badge, which is how the badge came to lie.");
	assert.match(webIndex, /syncAndReport\(\)[\s\S]{0,80}?this\.syncLiveState\(\)/,
		"the single call site must be inside syncAndReport");
});
