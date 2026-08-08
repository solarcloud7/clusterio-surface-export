/**
 * Image imports resolve to a URL string.
 *
 * `@clusterio/web_ui`'s webpack.common declares `{ test: /\.png$/, type: "asset/resource" }` with a
 * content-hashed `assetModuleFilename`, and this plugin's config merges that rule rather than
 * replacing it — so a `.png` import emits a hashed file under `static/` and evaluates to its URL.
 * TypeScript has no idea about any of that, hence this declaration.
 *
 * This is the plugin's FIRST use of that rule. Everything else on screen comes from Factorio's
 * server-served spritesheet via `FactorioIcon`, which is the right default: it tracks whatever the
 * mod pack actually has. The exception here is deliberate and narrow — see web/assets/README.md.
 */
declare module "*.png" {
	const url: string;
	export default url;
}
