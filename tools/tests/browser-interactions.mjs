// AntD Select can intercept clicks and virtualize options outside the visible window.
export async function selectOption(page, label, option, scope = page) {
	const input = scope.getByRole("combobox", { name: label, exact: true });
	await input.press("ArrowDown");
	await input.press("Home");
	const list = page.locator(".ant-select-dropdown:not(.ant-select-dropdown-hidden)");
	// Home resets virtualization. Keyboard navigation keeps the active option rendered.
	for (let count = 0; count < 200; count++) {
		const exact = new RegExp(`^${option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
		const target = list.locator(".ant-select-item-option-content").filter({ hasText: exact });
		if (await target.count() && await target.first().isVisible()) {
			await target.first().click(); return;
		}
		await input.press("ArrowDown");
	}
	throw new Error(`Select '${label}' has no reachable option '${option}' within 200 entries`);
}

export async function showGatewayPlatform(page, instance, platform) {
	const node = page.locator(".react-flow__node").filter({ has: page.getByText(instance, { exact: true }) }).first();
	await node.getByText(instance, { exact: true }).click();
	const row = node.getByText(platform, { exact: true });
	await row.waitFor({ state: "visible" });
	return row;
}
