#!/bin/bash
set -euo pipefail
mkdir -p /clusterio/static /clusterio/logs /clusterio/mods
chown clusterio:clusterio /clusterio/static /clusterio/logs /clusterio/mods
case "$SURFACE_EXPORT_ROLE" in
  controller) exec /controller-entrypoint.sh ;;
  host) exec /host-entrypoint.sh ;;
  *) echo "Unknown runtime role" >&2; exit 1 ;;
esac
