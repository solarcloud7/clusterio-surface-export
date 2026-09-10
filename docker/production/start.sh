#!/bin/bash
set -euo pipefail
# Only writable runtime paths are prepared here; packaged code is supplied by the image.
mkdir -p /clusterio/static /clusterio/logs /clusterio/mods
chown clusterio:clusterio /clusterio/static /clusterio/logs /clusterio/mods
case "$SURFACE_EXPORT_ROLE" in
  controller) exec /controller-entrypoint.sh ;;
  host)
    mkdir -p /clusterio/data
    chown clusterio:clusterio /clusterio/data
    gosu clusterio node /release/configure-host.cjs
    exec /host-entrypoint.sh ;;
  *) echo "Unknown runtime role" >&2; exit 1 ;;
esac
