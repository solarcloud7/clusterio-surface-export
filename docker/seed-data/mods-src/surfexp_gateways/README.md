# surfexp_gateways (data-stage mod)

Source of truth for the `surfexp_gateways` Factorio mod. The **built zip** lives at
`docker/seed-data/mods/surfexp_gateways_<version>.zip` (force-tracked past the `*.zip` gitignore so CI
gets it). **After editing anything here, rebuild the zip** — otherwise the source and the shipped zip
drift:

```powershell
./tools/surface-export/build-gateway-mod.ps1            # zip source -> docker/seed-data/mods/
./tools/surface-export/build-gateway-mod.ps1 -Upload    # also upload to the running cluster + add to the
                                         # "Space Age 2.0" pack + restart hosts (no down -v)
```

It is a **pure data-stage mod** (no `control.lua`): it only adds surfaceless gateway
`space-location`s + short `space-connection`s from nauvis. All gateway *logic* (discovery, unlock,
arrival detection, transfer trigger, hop-strip) lives in the save-patched `surface_export` module, not
here. See `docs/GATEWAY_TRANSFER_PRD.md`.

## Graphics

`graphics/icons/` carries two files per gateway, the same split space-age uses for its own planets:

| File | Size | Rendered by |
|---|---|---|
| `gateway-<colour>.png` | 64×64 | schedule/station picker, tooltips, lists (`icon`; `icon_size` defaults to 64) |
| `starmap-gateway-<colour>.png` | 512×512 | the starmap (`starmap_icon` + `starmap_icon_size = 512`) |

The 512px files ARE the source art, kept here at full resolution rather than duplicated elsewhere in
the repo. The 64px files are **derived** from them by an exact 8:1 alpha-weighted area average —
regenerate the same way if the art changes, since a plain non-premultiplied resize fringes the
transparent rim dark. Colour order is gateway order:
1=blue, 2=green, 3=orange, 4=purple. `GATEWAY_COLOURS` in `data.lua` is the source of truth and its
length IS the gateway count, so a gateway cannot exist without art.

A declared size that disagrees with the actual PNG is a hard data-stage load error, so an instance
that boots and answers RCON has proven every icon path and size resolved.

Because it is data-only, it can be added to a running cluster without a `docker compose down -v`
(upload + `mod-pack edit` + restart hosts — what `-Upload` does). The `down -v` reseed is only needed
for a from-scratch first-run modpack assignment.
