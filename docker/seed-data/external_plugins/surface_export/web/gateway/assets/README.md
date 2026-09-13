# Gateway web artwork

`gateway-hub-128.png` is derived from the gateway mod's 512-pixel starmap image.
Other Factorio icons use the instance mod pack's exported spritesheet.

From the repository root:

```text
node tools/surface-export/downscale-icon.mjs docker/seed-data/mods-src/surfexp_gateways/graphics/icons/starmap-gateway-hub.png docker/seed-data/external_plugins/surface_export/web/gateway/assets/gateway-hub-128.png --factor=4
```

The plugin's `scripts/lint-derived-art.mjs` rederives registered images and checks
byte equality. Register another derived image in that guard rather than creating
an untracked copy of its source. This checks provenance, not subjective sharpness
or whether a client displays the intended artwork.

See [gateway mod development](../../../../../../../docs/developers/gateway-mod.md).
