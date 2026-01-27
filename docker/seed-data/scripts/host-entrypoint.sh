#!/bin/bash
set -e

echo "========================================"
echo "Clusterio Host Startup: ${HOST_NAME}"
echo "========================================"

# Create necessary directories as root
mkdir -p /clusterio/logs /clusterio/instances /clusterio/plugins
chown -R factorio:factorio /clusterio/logs /clusterio/instances
chown factorio:factorio /clusterio

PLUGIN_SRC="/opt/seed-plugins/surface-export"
PLUGIN_DST="/clusterio/plugins/surface_export"
echo "Syncing surface export plugin into persistent volume..."
rm -rf "${PLUGIN_DST}"
mkdir -p /clusterio/plugins
cp -R "${PLUGIN_SRC}" "${PLUGIN_DST}"

# Clusterio save patching discovers Lua modules under `<plugin>/modules/<moduleName>/`.
# This repo's plugin keeps its module in `module/`, so create a compatible view.
if [ -d "${PLUGIN_DST}/module" ] && [ ! -e "${PLUGIN_DST}/modules/surface_export" ]; then
  mkdir -p "${PLUGIN_DST}/modules"
  ln -s "${PLUGIN_DST}/module" "${PLUGIN_DST}/modules/surface_export"
fi

# BUGFIX: Override clusterio core modules with our fixed version (race condition fix)
# Copy the fixed impl.lua to the npm-installed location where Clusterio loads it from
echo "Installing fixed Clusterio impl.lua (race condition fix)..."
cp -f /opt/clusterio_modules/impl.lua \
  /usr/lib/node_modules/@clusterio/host/modules/clusterio/impl.lua || {
  echo "WARNING: Could not copy fixed impl.lua - race condition fix not applied"
}

chown -R factorio:factorio /clusterio/plugins

# Note: Clusterio manages mods at /clusterio/mods and instance saves at /clusterio/instances/<instance-name>/saves
# The controller syncs mods to each host automatically, and instances create their own save directories
# The built-in DLC mods (space-age, quality, elevated-rails) are already uploaded to the controller
# and will be distributed as part of the mod pack sync process
echo "Clusterio will handle mod and save synchronization from controller"

echo "Ensuring server admin list is generated from FACTORIO_ADMINS..."
ADMIN_LIST_VALUE="${FACTORIO_ADMINS:-admin}"
ADMIN_LIST_FILE="/clusterio/server-adminlist.json"
ADMIN_LIST_LINK="/factorio/server-adminlist.json"

ADMIN_LIST_FILE="${ADMIN_LIST_FILE}" ADMIN_LIST_VALUE="${ADMIN_LIST_VALUE}" python3 <<'PY'
import json, os, sys
path = os.environ.get("ADMIN_LIST_FILE")
admins_raw = os.environ.get("ADMIN_LIST_VALUE", "")
admins = [entry.strip() for entry in admins_raw.split(",") if entry.strip()]
if not admins:
  admins = ["admin"]
if not path:
  sys.exit("ADMIN_LIST_FILE not set")
with open(path, "w", encoding="utf-8") as fh:
  json.dump(admins, fh, indent=2)
PY

chown factorio:factorio "${ADMIN_LIST_FILE}"
ln -sf "${ADMIN_LIST_FILE}" "${ADMIN_LIST_LINK}"
chown -h factorio:factorio "${ADMIN_LIST_LINK}"

# Switch to factorio user for rest of execution
su -s /bin/bash factorio <<'FACTORIO_USER'
cd /clusterio

# Wait for host config to exist (created by init service)
HOST_CONFIG="/clusterio/config-host.json"
max_attempts=60
attempt=0
while [ ! -f "${HOST_CONFIG}" ]; do
  attempt=$((attempt + 1))
  if [ $attempt -ge $max_attempts ]; then
    echo "ERROR: Host config not found after ${max_attempts} seconds"
    echo "Expected: ${HOST_CONFIG}"
    exit 1
  fi
  echo "Waiting for host configuration... ($attempt/$max_attempts)"
  sleep 1
done

echo "Host configuration found: ${HOST_CONFIG}"
echo ""

# Set Factorio directory in host config
npx clusteriohost --log-level error config set host.factorio_directory /opt/factorio
npx clusteriohost --log-level error config set host.instances_directory /clusterio/instances

echo "Starting Clusterio Host..."
echo "Host will connect to controller and wait for instance assignment."
echo "========================================"

exec npx clusteriohost --log-level error run
FACTORIO_USER
