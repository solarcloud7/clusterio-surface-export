#!/bin/bash
set -e

# Use environment variables with defaults
HTTP_PORT=${CONTROLLER_HTTP_PORT:-8080}

echo "========================================"
echo "Clusterio Controller Startup"
echo "========================================"

# Ensure custom plugins are present in the controller's persistent plugin directory.
# Hosts already sync this plugin on boot; controller needs it too so it can load the
# controller-side plugin and avoid version mismatch warnings.
PLUGIN_SRC="/opt/seed-plugins/surface-export"
PLUGIN_DST="/clusterio/plugins/surface_export"

if [ -d "${PLUGIN_SRC}" ]; then
  echo "Syncing surface export plugin into controller persistent volume..."
  mkdir -p /clusterio/plugins
  rm -rf "${PLUGIN_DST}"
  cp -R "${PLUGIN_SRC}" "${PLUGIN_DST}"

  # Clusterio save patching discovers Lua modules under `<plugin>/modules/<moduleName>/`.
  # This repo stores its module in `module/`, so create a compatible view.
  if [ -d "${PLUGIN_DST}/module" ] && [ ! -e "${PLUGIN_DST}/modules/surface_export" ]; then
    mkdir -p "${PLUGIN_DST}/modules"
    ln -s "${PLUGIN_DST}/module" "${PLUGIN_DST}/modules/surface_export"
  fi
else
  echo "WARNING: ${PLUGIN_SRC} not found; surface_export plugin will not be synced"
fi

# Initialize controller config if it does not exist
if [ ! -f "/clusterio/config-controller.json" ]; then
  echo "Creating controller configuration..."
  npx clusteriocontroller --log-level error config set controller.name "Surface Export Controller"
  npx clusteriocontroller --log-level error config set controller.bind_address "0.0.0.0"
  npx clusteriocontroller --log-level error config set controller.http_port $HTTP_PORT
  
  # Enable plugin installation (must be set locally before controller starts)
  echo "Enabling plugin installation..."
  npx clusteriocontroller --log-level error config set controller.allow_plugin_install true
  npx clusteriocontroller --log-level error config set controller.allow_plugin_updates true

  # Note: Modern Clusterio (v2.0+) loads plugins automatically from /clusterio/plugins
  # The old-style 'load_plugin' config fields have been removed
  # Built-in plugins are always available and don't need explicit loading

  # Plugin config: Don't set plugin configs here - plugins are loaded by the init script
  # Plugin config fields will use their default initialValue from the plugin definition
  
  # Set Factorio credentials if provided
  if [ -n "$FACTORIO_USERNAME" ]; then
    echo "Setting Factorio username..."
    npx clusteriocontroller --log-level error config set controller.factorio_username "$FACTORIO_USERNAME"
  fi
  if [ -n "$FACTORIO_TOKEN" ]; then
    echo "Setting Factorio token..."
    npx clusteriocontroller --log-level error config set controller.factorio_token "$FACTORIO_TOKEN"
  fi
  
  echo "Controller configuration created."
else
  echo "Using existing controller configuration."
  # Ensure plugin installation is enabled even on existing configs
  echo "Verifying plugin installation is enabled..."
  npx clusteriocontroller --log-level error config set controller.allow_plugin_install true
  npx clusteriocontroller --log-level error config set controller.allow_plugin_updates true
fi

# Create admin user BEFORE starting controller (if not exists)
# This ensures the user is loaded into memory when controller starts
if [ ! -f "/clusterio/database/users.json" ]; then
  echo "Creating admin user..."
  npx clusteriocontroller --log-level error bootstrap create-admin admin
  echo "Admin user created successfully"
else
  echo "User database exists, skipping admin user creation"
fi

echo ""
echo "Starting Clusterio Controller..."
echo "HTTP API: http://0.0.0.0:$HTTP_PORT"
echo "WebSocket API: ws://0.0.0.0:$HTTP_PORT/api/socket (same port as HTTP)"
echo "=========================================="
# Note: --dev mode requires webpack (not installed in container)
# Plugin changes require controller restart, Lua module changes require instance restart
exec npx clusteriocontroller run
