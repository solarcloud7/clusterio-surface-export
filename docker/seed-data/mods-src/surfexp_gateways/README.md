# surfexp_gateways (data-stage mod)

Source of truth for the `surfexp_gateways` Factorio mod. The **built zip** lives at
`docker/seed-data/mods/surfexp_gateways_<version>.zip` (force-tracked past the `*.zip` gitignore so CI
gets it). **After editing anything here, rebuild the zip** — otherwise the source and the shipped zip
drift:

```powershell
./tools/build-gateway-mod.ps1            # zip source -> docker/seed-data/mods/
./tools/build-gateway-mod.ps1 -Upload    # also upload to the running cluster + add to the
                                         # "Space Age 2.0" pack + restart hosts (no down -v)
```

It is a **pure data-stage mod** (no `control.lua`): it only adds surfaceless gateway
`space-location`s + short `space-connection`s from nauvis. All gateway *logic* (discovery, unlock,
arrival detection, transfer trigger, hop-strip) lives in the save-patched `surface_export` module, not
here. See `docs/GATEWAY_TRANSFER_PRD.md`.

Because it is data-only, it can be added to a running cluster without a `docker compose down -v`
(upload + `mod-pack edit` + restart hosts — what `-Upload` does). The `down -v` reseed is only needed
for a from-scratch first-run modpack assignment.
