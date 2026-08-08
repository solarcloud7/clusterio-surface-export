# web/assets

The only images this plugin bundles. Everything else on screen comes from Factorio's
server-served spritesheet through `FactorioIcon` (see `web/icons.tsx`), which is the right default
because it tracks whatever the mod pack actually contains.

## Why the exception

`gateway-hub-128.png` is the face of an instance node in **1 Gate Cluster** mode, drawn at the node's
full diameter (150 px). The spritesheet cannot supply that: its atlas cell for a `space-location` is
**32x32** — measured in the live metadata, `{"x":0,"y":1376,"size":32}` — so filling a 150 px node
from it is a 4.7x upscale. At 1.4x the sprite is already visibly soft; at 4.7x it is mush.

Multi Cluster mode still uses the spritesheet, because there the four gateway icons render at 26 px
on the node rim, where 32 px is plenty.

## Regenerating

Derived from the mod's own 512 px starmap art with the committed downscaler, so it is reproducible
rather than a hand-export:

```bash
node tools/surface-export/downscale-icon.mjs \
  docker/seed-data/mods-src/surfexp_gateways/graphics/icons/starmap-gateway-hub.png \
  docker/seed-data/external_plugins/surface_export/web/gateway/assets/gateway-hub-128.png --factor=4
```

128 px, not 256 or 512: at a 150 px node it is a 1.17x upscale (effectively sharp) for 40 KB, where
256 would be ~4x the bytes to fix a difference nobody can see.

## The hazard, and the check for it

This is a SECOND COPY of art whose source of truth is the mod, so changing
`starmap-gateway-hub.png` would leave this stale — showing last month’s art with no error anywhere.

`scripts/lint-derived-art.mjs` (in `npm run lint`) re-derives every entry here from its source in
memory and demands byte equality, printing the regeneration command when it drifts. Byte equality is
fair here precisely because the committed file came from this same code path — unlike
`downscale-icon --verify`, which compares against art made by an unknown external tool and therefore
allows a measured tolerance.

A new image dropped into this directory without a `DERIVED` entry is REFUSED, not silently trusted,
so the guard cannot quietly cover less than the directory it claims to.
