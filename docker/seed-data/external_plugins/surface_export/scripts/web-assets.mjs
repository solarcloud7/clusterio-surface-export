import { copyFile, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

function assetPath(directory, name) {
	if (typeof name !== "string" || !/^static\/[A-Za-z0-9_./-]+$/.test(name)
		|| name.split("/").some(part => part === ".." || part === ".")) {
		throw new Error(`Invalid web asset path: ${name}`);
	}
	return join(directory, name);
}

async function filesIn(directory, prefix = "") {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const name = prefix + entry.name;
		if (entry.isDirectory()) files.push(...await filesIn(join(directory, entry.name), name + "/"));
		else if (entry.isFile()) files.push(name);
		else throw new Error(`Unexpected web build entry: ${name}`);
	}
	return files;
}

export async function publishWebAssets(staging, destination) {
	staging = resolve(staging); destination = resolve(destination);
	if (staging === destination || staging.startsWith(destination + sep) || destination.startsWith(staging + sep)) {
		throw new Error("Web staging and publication directories must be separate");
	}
	const files = await filesIn(staging);
	const manifestText = await readFile(join(staging, "manifest.json"), "utf8");
	const manifest = JSON.parse(manifestText);
	if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
		|| typeof manifest["surface_export.js"] !== "string") throw new Error("Missing surface_export.js in web manifest");
	for (const name of Object.values(manifest)) {
		assetPath(staging, name);
		if (!files.includes(name)) throw new Error(`Missing emitted web asset: ${name}`);
	}
	const assets = files.filter(name => name !== "manifest.json");
	for (const name of assets) {
		assetPath(staging, name);
		if (!/(?:^|\.)[a-f0-9]{8,}\./i.test(basename(name))) throw new Error(`Web asset needs an immutable hash: ${name}`);
		const target = assetPath(destination, name);
		try {
			const stat = await lstat(target);
			if (!stat.isFile() || !(await readFile(target)).equals(await readFile(join(staging, name)))) {
				throw new Error(`Refusing to replace immutable web asset: ${name}`);
			}
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	await mkdir(destination, { recursive: true });
	for (const name of assets) {
		const target = assetPath(destination, name);
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.${randomUUID()}.tmp`;
		try {
			await copyFile(join(staging, name), temporary);
			await rename(temporary, target);
		} finally {
			await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
		}
	}
	const temporary = join(destination, `manifest.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, manifestText);
		await rename(temporary, join(destination, "manifest.json"));
	} finally {
		await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
	}
	return manifest;
}
