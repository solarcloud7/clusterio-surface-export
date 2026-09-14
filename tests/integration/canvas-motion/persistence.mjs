import assert from "node:assert/strict";

export async function checkMarkerPersistence(page) {
	const scene = page.getByTestId("transfer-motion-preview");
	const marker = scene.locator(".surface-export-edge-status");
	const next = () => page.getByRole("button", { name: "Next phase", exact: true }).click();
	const settleAt = async (distance, label) => {
		await page.clock.runFor(2000);
		assert.equal(await marker.count(), 1, `${label}: marker is present`);
		assert.match(await marker.getAttribute("title"), label);
		assert.equal(await marker.evaluate(el => parseFloat(getComputedStyle(el).offsetDistance)), distance);
		assert.ok(Number(await marker.evaluate(el => getComputedStyle(el).opacity)) > 0.1);
	};
	const advanceMarkerTime = async () => {
		await marker.evaluate(el => {
			for (const animation of el.getAnimations({ subtree: true })) {
				animation.currentTime = Number(animation.currentTime ?? 0) + 10500;
			}
		});
		await page.clock.runFor(10500);
	};
	const remainsVisible = async label => {
		await advanceMarkerTime();
		assert.equal(await marker.count(), 1, `${label}: marker survives beyond ten seconds`);
		assert.ok(Number(await marker.evaluate(el => getComputedStyle(el).opacity)) > 0.1,
			`${label}: marker stays visible beyond ten seconds`);
		console.log(`PASS ${label} remains visible beyond ten seconds`);
	};

	await next();
	await settleAt(50, /validating/);
	await remainsVisible("validation");
	await next();
	await settleAt(100, /arrived/);
	await advanceMarkerTime();
	assert.equal(await marker.count(), 1);
	assert.ok(Number(await marker.evaluate(el => getComputedStyle(el).opacity)) < 0.1,
		"completed marker fades after ten seconds");
	console.log("PASS completed marker fades after ten seconds");
	for (let step = 0; step < 6; step++) await next();
	await settleAt(50, /cleanup needs attention/);
	assert.doesNotMatch(await marker.getAttribute("title"), /arrived|returned/);
	await remainsVisible("unresolved cleanup");
	await page.getByRole("button", { name: "Show queue", exact: true }).click();
	await settleAt(100, /queued/);
	await remainsVisible("queue");
}
