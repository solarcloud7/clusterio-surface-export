#!/bin/bash
# Clusterio Cluster Initialization Script
# This script sets up a complete Clusterio cluster with:
# - 1 Controller (already running)
# - 2 Hosts (clusterio-host-1, clusterio-host-2)
# - 2 Instances (surface-export-instance-1, surface-export-instance-2)
#
# This script is run by the clusterio-init service container after the controller is healthy.

set -e

CONTROLLER_HTTP_PORT="${CONTROLLER_HTTP_PORT:-8080}"
CONTROLLER_URL="http://clusterio-controller:${CONTROLLER_HTTP_PORT}/"
CLUSTERIO_DIR="/clusterio"
CONFIG_CONTROL="${CLUSTERIO_DIR}/config-control.json"
CONTROLLER_MODS_DIR="${CLUSTERIO_DIR}/mods"
HOSTS_DIR="/clusterio-hosts"
MOD_PACK_NAME="my-server-pack"
MOD_PACK_FACTORIO_VERSION="${MOD_PACK_FACTORIO_VERSION:-2.0}"
SURFACE_EXPORT_MOD_VERSION="${SURFACE_EXPORT_MOD_VERSION:-1.0.35}"
SEED_MODS_DIR="/opt/seed-mods"
SEED_SAVES_DIR="/opt/seed-saves"

QUIET_LOG="/clusterio/logs/init-commands.log"
QUIET_LOG_DIR="$(dirname "$QUIET_LOG")"
mkdir -p "$QUIET_LOG_DIR"
: > "$QUIET_LOG"

# Arrays to track upload failures
declare -a FAILED_MODS=()
declare -a FAILED_REASONS=()

run_quiet() {
    local label="$1"
    shift
    local output
    if output=$("$@" 2>&1); then
        echo "[OK] $label"
        return 0
    else
        echo "[FAIL] $label"
        {
            echo "---- $label ----"
            echo "$output"
            echo "-----------------"
        } >> "$QUIET_LOG"
        echo "    See $QUIET_LOG for command output."
        return 1
    fi
}

upload_mod_only() {
    local mod_zip="$1"
    local attempt=1
    local max_attempts=3

    if [ ! -f "$mod_zip" ]; then
        return 1
    fi

    local filename
    filename=$(basename "$mod_zip")
    local target_path="${CONTROLLER_MODS_DIR}/${filename}"

    while [ $attempt -le $max_attempts ]; do
        local success=true
        
        # 1. Upload Logic
        if [ ! -f "$target_path" ]; then
            local upload_output
            if ! upload_output=$(timeout 120 npx clusterioctl --log-level error mod upload "$mod_zip" 2>&1); then
                success=false
                if [ $attempt -eq $max_attempts ]; then
                    local reason="Unknown error (check logs)"
                    if echo "$upload_output" | grep -q "Invalid dependency prefix"; then
                        reason=$(echo "$upload_output" | grep "Invalid dependency prefix" | head -1 | sed 's/.*Invalid dependency prefix: //')
                    elif echo "$upload_output" | grep -q "Unknown version equality"; then
                        reason=$(echo "$upload_output" | grep "Unknown version equality" | head -1 | sed 's/.*Unknown version equality: //')
                    elif echo "$upload_output" | grep -q "Error running command"; then
                        reason=$(echo "$upload_output" | grep "Error running command" | head -1 | sed 's/.*Error running command: //')
                    fi
                    
                    echo "✗ ${filename} - ${reason}"
                    echo "${filename}|${reason}" >> /tmp/clusterio_failed_mods
                    return 1
                else
                     echo "  ⚠ Upload failed for ${filename}, retrying..."
                fi
            else
                echo "✓ ${filename} (uploaded)"
            fi
        else
            if [ $attempt -eq 1 ]; then
                echo "✓ ${filename} (already present)"
            fi
        fi

        if [ "$success" = true ]; then
            local without_ext="${filename%.zip}"
            local mod_version="${without_ext##*_}"
            local mod_name="${without_ext%_*}"
            echo "${mod_name}:${mod_version}" >> /tmp/clusterio_uploaded_mods
            return 0
        fi

        sleep 2
        attempt=$((attempt + 1))
    done
    
    return 1
}

add_mod_to_pack_if_missing() {
    local mod_name="$1"
    local mod_version="$2"
    local mod_pack_name="$3"
    local progress_msg="$4"

    if [ -z "$mod_pack_name" ]; then
        echo "Warning: Mod pack name not provided; cannot add ${mod_name}"
        return
    fi

    local pack_state
    pack_state=$(timeout 10 npx clusterioctl --log-level error mod-pack show "$mod_pack_name" 2>/dev/null || true)
    if echo "$pack_state" | grep -F "${mod_name} ${mod_version}" >/dev/null 2>&1; then
        echo "Mod ${mod_name} ${mod_version} already present in ${mod_pack_name}"
        return
    fi

    local label="Add ${mod_name} ${mod_version} to ${mod_pack_name}"
    if [ -n "$progress_msg" ]; then
        label="${progress_msg} ${label}"
    fi

    if run_quiet "$label" \
        timeout 15 npx clusterioctl --log-level error mod-pack edit "$mod_pack_name" --add-mods "${mod_name}:${mod_version}" --enable-mods "$mod_name"; then
        return
    fi
    echo "Warning: Failed to add ${mod_name} to ${mod_pack_name}"
}

seed_mod_pack_mods() {
    if [ -z "$MOD_PACK_ID" ]; then
        echo "Skipping mod upload; mod pack ID unavailable."
        return
    fi

    if [ ! -d "$SEED_MODS_DIR" ]; then
        echo "Seed mods directory ${SEED_MODS_DIR} not found; nothing to upload."
        return
    fi

    local -a mod_archives=()

    shopt -s nullglob
    local seed_zip
    for seed_zip in "${SEED_MODS_DIR}"/*.zip; do
        mod_archives+=("$seed_zip")
    done
    shopt -u nullglob

    local total_mods=${#mod_archives[@]}
    if [ $total_mods -eq 0 ]; then
        echo "No seed mod archives found under ${SEED_MODS_DIR}. Drop .zip files there to auto-upload them."
        return
    fi

    echo "Uploading ${total_mods} mods..."
    echo ""
    
    : > /tmp/clusterio_uploaded_mods
    : > /tmp/clusterio_failed_mods
    
    local mod_zip
    local batch_pids=()
    local BATCH_SIZE=15
    
    for mod_zip in "${mod_archives[@]}"; do
        # Upload only (parallel)
        upload_mod_only "$mod_zip" &
        batch_pids+=($!)

        # If batch is full, wait for it to clear
        if [ ${#batch_pids[@]} -ge $BATCH_SIZE ]; then
            wait
            batch_pids=()
        fi
    done
    
    # Wait for remaining
    wait
    
    # Process Results
    local uploaded_count=0
    if [ -f /tmp/clusterio_uploaded_mods ]; then
        uploaded_count=$(wc -l < /tmp/clusterio_uploaded_mods)
    fi
    
    echo ""
    echo "Upload completed: ${uploaded_count}/${total_mods} mods."

    if [ $uploaded_count -gt 0 ]; then
        echo "Adding mods to pack '${MOD_PACK_NAME}'..."
        
        # Build one huge command or batch it?
        # 60 mods * ~50 chars = 3000 chars. Command line limit is high (128k+ usually). 
        # We can do it in one go.
        
        local add_args=()
        while read -r mod_entry; do
            # Entry format: name:version
            if [ -n "$mod_entry" ]; then
                 local m_name="${mod_entry%:*}"
                 add_args+=("--add-mods" "$mod_entry" "--enable-mods" "$m_name")
            fi
        done < /tmp/clusterio_uploaded_mods
        
        # Split into chunks of 20 to be safe (and show progress)
        local chunk_size=20
        local chunk_args=()
        local count=0
        
        for ((i=0; i<${#add_args[@]}; i+=4)); do # 4 args per mod (--add-mods val --enable-mods val)
             chunk_args+=("${add_args[i]}" "${add_args[i+1]}" "${add_args[i+2]}" "${add_args[i+3]}")
             count=$((count + 1))
             
             if [ $count -ge $chunk_size ]; then
                  echo "  Applying batch of $count mods to pack..."
                  if ! timeout 60 npx clusterioctl --log-level error mod-pack edit "$MOD_PACK_NAME" "${chunk_args[@]}" >/dev/null 2>&1; then
                      echo "  ❌ Failed to apply batch!"
                  fi
                  chunk_args=()
                  count=0
             fi
        done
        
        if [ ${#chunk_args[@]} -gt 0 ]; then
             echo "  Applying remaining $count mods to pack..."
             if ! timeout 60 npx clusterioctl --log-level error mod-pack edit "$MOD_PACK_NAME" "${chunk_args[@]}" >/dev/null 2>&1; then
                  echo "  ❌ Failed to apply batch!"
             fi
        fi
        echo "Mod pack update complete."
    fi

    # Report failed mods if any
    if [ -f /tmp/clusterio_failed_mods ] && [ -s /tmp/clusterio_failed_mods ]; then
        echo ""
        echo "Failed uploads:"
        while IFS='|' read -r fname reason; do
            echo "  - ${fname}: ${reason}"
        done < /tmp/clusterio_failed_mods
    fi


    # Note: FactorioSurfaceExport only depends on base, space-age, and clusterio_lib
    # All other mods were removed for minimal testing setup
}

enable_builtin_dlc_mods() {
    local pack_name="$1"
    if [ -z "$pack_name" ]; then
        echo "Skipping built-in DLC enablement; mod pack name missing."
        return
    fi

    echo "Enabling built-in DLC mods in ${pack_name}..."
    
    # DLCs are built into Factorio and don't need uploads; just mark them enabled in the pack
    # Enable all DLCs in a single command for speed
    if timeout 15 npx clusterioctl --log-level error mod-pack edit "$pack_name" \
            --add-mods space-age:2.0.0 --enable-mods space-age \
            --add-mods quality:2.0.0 --enable-mods quality \
            --add-mods elevated-rails:2.0.0 --enable-mods elevated-rails; then
        echo "[OK] All DLCs enabled (space-age, quality, elevated-rails)"
    else
        echo "[WARN] Failed to enable DLCs"
    fi
}

# add_preinstalled_plugin() {
#     local plugin_label="$1"
#     local plugin_path="$2"

#     if [ -z "$plugin_path" ] || [ ! -d "$plugin_path" ]; then
#         echo "Warning: Plugin path ${plugin_path} for ${plugin_label} not found; skipping."
#         return
#     fi

#     echo "Adding plugin '${plugin_label}' from ${plugin_path}..."
#     local output
#     if output=$(timeout 20 npx clusterioctl --log-level error plugin add "$plugin_path" 2>&1); then
#         if echo "$output" | grep -qi "already added\|already exists"; then
#             echo "[OK] Plugin ${plugin_label} already configured"
#         else
#             echo "[OK] Plugin ${plugin_label} configured"
#         fi
#     else
#         if echo "$output" | grep -qi "already added\|already exists\|same.*already exists"; then
#             echo "[OK] Plugin ${plugin_label} already configured"
#         else
#             echo "[FAIL] Plugin ${plugin_label} configuration"
#             {
#                 echo "---- Plugin ${plugin_label} ----"
#                 echo "$output"
#                 echo "------------------------------"
#             } >> "$QUIET_LOG"
#             echo "    See $QUIET_LOG for command output."
#         fi
#     fi
# }

get_mod_pack_id() {
    local pack_name="$1"
    local list_output
    list_output=$(timeout 10 npx clusterioctl --log-level error mod-pack list 2>/dev/null || true)
    if [ -z "$list_output" ]; then
        echo ""
        return
    fi
    echo "$list_output" | awk -F'|' -v target="$pack_name" '
        index($0, "|") {
            name=$2; gsub(/^ +| +$/, "", name);
            id=$1; gsub(/^ +| +$/, "", id);
            if (name == target) {
                print id;
                exit;
            }
        }
    '
}

wait_for_host_connection() {
    local host_name="$1"
    local max_attempts="${2:-60}"
    local attempt=0
    while [ $attempt -lt $max_attempts ]; do
        local list_output
        list_output=$(timeout 10 npx clusterioctl --log-level error host list 2>/dev/null || true)
        if [ -n "$list_output" ]; then
            local connected
            connected=$(echo "$list_output" | awk -F'|' -v target="$host_name" '
                index($0, "|") {
                    name=$2; gsub(/^ +| +$/, "", name);
                    conn=$4; gsub(/^ +| +$/, "", conn);
                    if (name == target) {
                        print conn;
                        exit;
                    }
                }
            ')
            if [ "$connected" = "true" ]; then
                return 0
            fi
        fi
        attempt=$((attempt + 1))
        sleep 2
    done
    return 1
}

CONTROL_CONFIG_EXISTS=false

echo "=========================================="
echo "Clusterio Cluster Initialization"
echo "=========================================="

# Wait for controller to be ready
echo "Waiting for controller to be ready..."
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    # Try to access the root web interface (returns HTML)
    if curl -sf "${CONTROLLER_URL}" > /dev/null 2>&1; then
        echo "Controller is ready!"
        break
    fi
    attempt=$((attempt + 1))
    echo "Attempt $attempt/$max_attempts - Controller not ready, waiting..."
    sleep 2
done

if [ $attempt -eq $max_attempts ]; then
    echo "ERROR: Controller did not become ready in time"
    exit 1
fi

# Check if already initialized
if [ -f "$CONFIG_CONTROL" ]; then
    CONTROL_CONFIG_EXISTS=true
    echo ""
    echo "Existing control config detected. Verifying current cluster state..."
    (
        cd $CLUSTERIO_DIR
        instances_exist=false
        configs_exist=false

        if timeout 10 npx clusterioctl --log-level error instance list 2>&1 | grep -q "clusterio-host-1-instance-1" && \
           timeout 10 npx clusterioctl --log-level error instance list 2>&1 | grep -q "clusterio-host-2-instance-1"; then
            instances_exist=true
        fi

        if [ -f "${HOSTS_DIR}/clusterio-host-1/config-host.json" ] && \
           [ -f "${HOSTS_DIR}/clusterio-host-2/config-host.json" ]; then
            configs_exist=true
        fi

        if [ "$instances_exist" = true ] && [ "$configs_exist" = true ]; then
            echo "Instances and host configs are present. Continuing to enforce configuration."
        else
            echo "Detected missing pieces (instances_exist=$instances_exist, configs_exist=$configs_exist). Continuing setup."
        fi
    )
fi

echo ""
echo "Preparing control config for admin user..."
cd $CLUSTERIO_DIR

if [ "$CONTROL_CONFIG_EXISTS" = true ]; then
    echo "Control config already exists at $CONFIG_CONTROL (skipping creation)."
else
    echo "Generating control config for admin user..."
    run_quiet "Create ctl config" npx clusteriocontroller --log-level error bootstrap create-ctl-config admin
fi

# Update the controller URL in the generated config
echo ""
echo "Configuring controller URL..."
run_quiet "Set controller URL" npx clusterioctl --log-level error control-config set control.controller_url "$CONTROLLER_URL"

echo ""
echo "=========================================="
echo "Creating Instances"
echo "=========================================="

# Check if instance 1 exists
if timeout 10 npx clusterioctl --log-level error instance list 2>/dev/null | grep -q "clusterio-host-1-instance-1"; then
    echo "Instance clusterio-host-1-instance-1 already exists, skipping creation"
else
    echo "Creating instance: clusterio-host-1-instance-1"
    if ! run_quiet "Create clusterio-host-1-instance-1" timeout 30 npx clusterioctl --log-level error instance create clusterio-host-1-instance-1 --id 1; then
        echo "ERROR: Failed to create instance clusterio-host-1-instance-1 (timeout or error)"
        exit 1
    fi
fi

# Check if instance 2 exists
if timeout 10 npx clusterioctl --log-level error instance list 2>/dev/null | grep -q "clusterio-host-2-instance-1"; then
    echo "Instance clusterio-host-2-instance-1 already exists, skipping creation"
else
    echo "Creating instance: clusterio-host-2-instance-1"
    if ! run_quiet "Create clusterio-host-2-instance-1" timeout 30 npx clusterioctl --log-level error instance create clusterio-host-2-instance-1 --id 2; then
        echo "ERROR: Failed to create instance clusterio-host-2-instance-1 (timeout or error)"
        exit 1
    fi
fi

echo ""
echo "Configuring instances (parallel)..."
# Run all config commands in parallel for both instances
(
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.game_port ${HOST1_INSTANCE1_GAME_PORT} &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.rcon_port ${HOST1_INSTANCE1_RCON_PORT} &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.rcon_password "${RCON_PASSWORD}" &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.enable_save_patching true &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.settings '{"name":"Clusterio Host 1 - Instance 1","description":"Clusterio development cluster - Host 1","auto_pause":false}' &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.sync_adminlist "bidirectional" &&
  npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 surface_export.debug_mode true &&
  if [ "${FACTORIO_AUTO_START:-false}" = "true" ]; then
    npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 instance.auto_start true
  fi
  echo "[OK] Configured clusterio-host-1-instance-1"
) &
INSTANCE1_PID=$!

(
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.game_port ${HOST2_INSTANCE1_GAME_PORT} &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.rcon_port ${HOST2_INSTANCE1_RCON_PORT} &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.rcon_password "${RCON_PASSWORD}" &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.enable_save_patching true &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.settings '{"name":"Clusterio Host 2 - Instance 1","description":"Clusterio development cluster - Host 2","auto_pause":false}' &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.sync_adminlist "bidirectional" &&
  npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 surface_export.debug_mode true &&
  if [ "${FACTORIO_AUTO_START:-false}" = "true" ]; then
    npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 instance.auto_start true
  fi
  echo "[OK] Configured clusterio-host-2-instance-1"
) &
INSTANCE2_PID=$!

# Wait for both to complete
wait $INSTANCE1_PID $INSTANCE2_PID

echo ""
echo "=========================================="
echo "Creating Host Configs"
echo "=========================================="

# Create host config for host-1
if [ -f "${HOSTS_DIR}/clusterio-host-1/config-host.json" ]; then
    echo "Host config for clusterio-host-1 already exists, skipping creation"
else
    echo "Creating host config: clusterio-host-1"
    if ! run_quiet "Create host config clusterio-host-1" \
        timeout 30 npx clusterioctl --log-level error host create-config \
            --name clusterio-host-1 \
            --id 1 \
            --generate-token \
            --output "${HOSTS_DIR}/clusterio-host-1/config-host.json"; then
        echo "ERROR: Failed to create host config for clusterio-host-1"
        exit 1
    fi
fi

# Create host config for host-2
if [ -f "${HOSTS_DIR}/clusterio-host-2/config-host.json" ]; then
    echo "Host config for clusterio-host-2 already exists, skipping creation"
else
    echo "Creating host config: clusterio-host-2"
    if ! run_quiet "Create host config clusterio-host-2" \
        timeout 30 npx clusterioctl --log-level error host create-config \
            --name clusterio-host-2 \
            --id 2 \
            --generate-token \
            --output "${HOSTS_DIR}/clusterio-host-2/config-host.json"; then
        echo "ERROR: Failed to create host config for clusterio-host-2"
        exit 1
    fi
fi

# Set controller URL in host configs (must have trailing slash)
echo ""
echo "Configuring host connection settings..."

# Update controller URL to use container DNS name instead of localhost
if [ -f "${HOSTS_DIR}/clusterio-host-1/config-host.json" ]; then
    sed -i "s|http://localhost:8080/|${CONTROLLER_URL}|" "${HOSTS_DIR}/clusterio-host-1/config-host.json"
    echo "[OK] Updated clusterio-host-1 controller URL"
fi

if [ -f "${HOSTS_DIR}/clusterio-host-2/config-host.json" ]; then
    sed -i "s|http://localhost:8080/|${CONTROLLER_URL}|" "${HOSTS_DIR}/clusterio-host-2/config-host.json"
    echo "[OK] Updated clusterio-host-2 controller URL"
fi

# Create users from FACTORIO_ADMINS environment variable (parallel)
if [ -n "${FACTORIO_ADMINS}" ]; then
    echo ""
    echo "Creating Factorio admin users from FACTORIO_ADMINS: ${FACTORIO_ADMINS}"
    IFS=',' read -ra ADMIN_ARRAY <<< "${FACTORIO_ADMINS}"
    for admin_name in "${ADMIN_ARRAY[@]}"; do
        # Trim whitespace
        admin_name=$(echo "$admin_name" | xargs)
        if [ -n "$admin_name" ]; then
            (
                # Use set-admin with --create flag (creates user if doesn't exist, then sets admin)
                if npx clusterioctl --log-level error user set-admin "$admin_name" --create 2>/dev/null; then
                    echo "[OK] Set $admin_name as in-game admin"
                else
                    echo "[WARN] Failed to set admin for $admin_name"
                fi
            ) &
        fi
    done
    wait  # Wait for all admin creations
fi

echo ""
echo "=========================================="
echo "Setting up Plugins"
echo "=========================================="

declare -a PREINSTALLED_PLUGINS=(
    "global_chat:/usr/lib/node_modules/@clusterio/plugin-global_chat"
    "inventory_sync:/usr/lib/node_modules/@clusterio/plugin-inventory_sync"
    "player_auth:/usr/lib/node_modules/@clusterio/plugin-player_auth"
    "research_sync:/usr/lib/node_modules/@clusterio/plugin-research_sync"
    "statistics_exporter:/usr/lib/node_modules/@clusterio/plugin-statistics_exporter"
    # "subspace_storage:/usr/lib/node_modules/@clusterio/plugin-subspace_storage"  # Disabled: Incompatible with Factorio 2.0
    "surface_export:/opt/seed-plugins/surface-export"
)

# Register plugins sequentially (cannot parallelize - writes to shared plugin-list.json)
# for plugin_entry in "${PREINSTALLED_PLUGINS[@]}"; do
#     plugin_label="${plugin_entry%%:*}"
#     plugin_path="${plugin_entry#*:}"
#     add_preinstalled_plugin "$plugin_label" "$plugin_path"
# done

# NOTE: Build and upload mods AFTER host configs are created
# This ensures authentication is working before mod operations

echo ""
echo "=========================================="
echo "Building and Uploading clusterio_lib"
echo "=========================================="

# Build clusterio_lib if not already built
if [ ! -f "/usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip" ]; then
    echo "Building clusterio_lib Factorio mod..."
    cd /usr/lib/node_modules/@clusterio/host
    if npm run build-mod -- --output-dir ./dist 2>&1 | grep -i "Writing dist"; then
        echo "✓ clusterio_lib built successfully"
    else
        echo "Warning: Failed to build clusterio_lib"
    fi
    cd $CLUSTERIO_DIR
else
    echo "✓ clusterio_lib already built"
fi

echo ""
echo "=========================================="
echo "Setting up Mod Pack"
echo "=========================================="

# Check if default mod pack exists, create if not
MOD_PACK_ID=$(get_mod_pack_id "$MOD_PACK_NAME")
if [ -z "$MOD_PACK_ID" ]; then
    echo "Mod pack '$MOD_PACK_NAME' not found. Creating for Factorio ${MOD_PACK_FACTORIO_VERSION}..."
    if run_quiet "Create mod pack $MOD_PACK_NAME" timeout 15 npx clusterioctl --log-level error mod-pack create "$MOD_PACK_NAME" "$MOD_PACK_FACTORIO_VERSION"; then
        MOD_PACK_ID=$(get_mod_pack_id "$MOD_PACK_NAME")
    else
        echo "Warning: Could not create mod pack"
    fi
else
    echo "Mod pack '$MOD_PACK_NAME' already exists (ID: $MOD_PACK_ID)"
fi

if [ -z "$MOD_PACK_ID" ]; then
    echo "Warning: Could not determine mod pack ID for '$MOD_PACK_NAME' after creation attempt"
else
    # Upload clusterio_lib first
    echo "Uploading clusterio_lib 2.0.20 to controller..."
    if ! npx clusterioctl --log-level error mod list 2>&1 | grep -q "clusterio_lib.*2.0.20"; then
        if timeout 30 npx clusterioctl --log-level error mod upload /usr/lib/node_modules/@clusterio/host/dist/clusterio_lib_2.0.20.zip; then
            echo "✓ clusterio_lib uploaded successfully"
        else
            echo "Warning: Failed to upload clusterio_lib"
        fi
    else
        echo "✓ clusterio_lib already uploaded"
    fi
    
    echo ""
    echo "Uploading baked mod archives and updating mod pack contents..."
    seed_mod_pack_mods
    
    # Note: FactorioSurfaceExport uses save patching, not standalone mod upload
    # The Lua code is injected from the plugin's module/ directory at instance startup
    
    enable_builtin_dlc_mods "$MOD_PACK_NAME"
    
    # Add clusterio_lib to the mod pack (required for IPC communication)
    echo "Adding clusterio_lib to mod pack..."
    add_mod_to_pack_if_missing "clusterio_lib" "2.0.20" "$MOD_PACK_NAME"
    
    # Explicitly enable clusterio_lib (in case add_mod_to_pack_if_missing didn't enable it)
    echo "Enabling clusterio_lib in mod pack..."
    run_quiet "Enable clusterio_lib" timeout 10 npx clusterioctl --log-level error mod-pack edit "$MOD_PACK_NAME" --enable-mods "clusterio_lib" || true
    
    # Note: FactorioSurfaceExport uses save patching - no mod pack registration needed
    # The Lua module is automatically patched from the plugin's module/ directory

    # Assign mod pack to both instances in parallel
    echo "Assigning mod pack (ID: $MOD_PACK_ID) to instances..."
    (run_quiet "Set mod pack for clusterio-host-1-instance-1" timeout 10 npx clusterioctl --log-level error instance config set clusterio-host-1-instance-1 factorio.mod_pack_id "$MOD_PACK_ID" || true) &
    (run_quiet "Set mod pack for clusterio-host-2-instance-1" timeout 10 npx clusterioctl --log-level error instance config set clusterio-host-2-instance-1 factorio.mod_pack_id "$MOD_PACK_ID" || true) &
    wait
fi

echo ""
echo "=========================================="
echo "Setting up Mod Pack (Deferred)"
echo "=========================================="
echo "Mod pack operations will be performed after host authentication is established..."

echo ""
echo "=========================================="
echo "Assigning Instances to Hosts"
echo "=========================================="

# Wait for hosts to connect so assignment succeeds (parallel)
echo "Waiting for hosts to register with controller..."
HOST1_READY=false
HOST2_READY=false

# Wait for both hosts in parallel
(wait_for_host_connection clusterio-host-1 90 && echo "clusterio-host-1 is connected" && touch /tmp/host1_ready) &
(wait_for_host_connection clusterio-host-2 90 && echo "clusterio-host-2 is connected" && touch /tmp/host2_ready) &
wait

if [ -f /tmp/host1_ready ]; then
    HOST1_READY=true
    rm -f /tmp/host1_ready
else
    echo "Warning: clusterio-host-1 never connected"
fi

if [ -f /tmp/host2_ready ]; then
    HOST2_READY=true
    rm -f /tmp/host2_ready
else
    echo "Warning: clusterio-host-2 never connected"
fi

# Assign instances to hosts
if [ "$HOST1_READY" = true ]; then
    echo "Assigning clusterio-host-1-instance-1 to clusterio-host-1..."
    if ! run_quiet "Assign instance 1" timeout 15 npx clusterioctl --log-level error instance assign clusterio-host-1-instance-1 clusterio-host-1; then
        echo "Warning: Could not assign instance 1 (may need to assign manually)"
    else
        # Seed saves into instance directory after assignment
        INSTANCE1_SAVES_DIR="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/saves"
        if [ -d "${SEED_SAVES_DIR}" ] && [ -n "$(ls -A ${SEED_SAVES_DIR} 2>/dev/null)" ]; then
            echo "Seeding saves into ${INSTANCE1_SAVES_DIR}..."
            mkdir -p "${INSTANCE1_SAVES_DIR}"
            cp -n ${SEED_SAVES_DIR}/*.zip "${INSTANCE1_SAVES_DIR}/" 2>/dev/null || true
            
            # Fix permissions (factorio user in host image is uid 999)
            chown -R 999:999 "$(dirname "${INSTANCE1_SAVES_DIR}")"
            
            echo "Saves seeded for instance 1"
            
            # Configure to load the specified or newest save
            SAVE_FILE=""
            if [ -n "${INSTANCE1_SAVE_NAME}" ]; then
                # Try to find the specified save file
                if [ -f "${INSTANCE1_SAVES_DIR}/${INSTANCE1_SAVE_NAME}" ]; then
                    SAVE_FILE="${INSTANCE1_SAVES_DIR}/${INSTANCE1_SAVE_NAME}"
                    echo "Using specified save for instance 1: ${INSTANCE1_SAVE_NAME}"
                else
                    echo "Warning: Specified save '${INSTANCE1_SAVE_NAME}' not found for instance 1"
                    echo "Available saves:"
                    ls -1 "${INSTANCE1_SAVES_DIR}"/*.zip 2>/dev/null | xargs -n1 basename || echo "  (none)"
                    echo "Falling back to newest save..."
                fi
            fi
            
            # If no specific save or not found, use the newest save file
            if [ -z "$SAVE_FILE" ]; then
                SAVE_FILE=$(ls -t "${INSTANCE1_SAVES_DIR}"/*.zip 2>/dev/null | head -n 1)
            fi
            
            if [ -n "$SAVE_FILE" ]; then
                SAVE_NAME=$(basename "$SAVE_FILE")
                echo "Seeded save found: $SAVE_NAME"

                # Ensure it has the latest modification time so Clusterio picks it up automatically
                touch "$SAVE_FILE"
                echo "Updated timestamp of $SAVE_NAME to ensure it is selected as the newest save."
            fi
        fi
        
        # Create server-adminlist.json for instance 1
        INSTANCE1_ADMINLIST="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/server-adminlist.json"
        if [ -n "${FACTORIO_ADMINS}" ]; then
            echo "Creating adminlist for instance 1 with admins: ${FACTORIO_ADMINS}"
            mkdir -p "$(dirname "${INSTANCE1_ADMINLIST}")"
            python3 -c "import json, sys; admins=[x.strip() for x in '${FACTORIO_ADMINS}'.split(',') if x.strip()]; json.dump(admins, sys.stdout)" > "${INSTANCE1_ADMINLIST}"
            chown 999:999 "${INSTANCE1_ADMINLIST}"
        fi
        
        # Enable clusterio_lib and FactorioSurfaceExport in mod-list.json for instance 1
        INSTANCE1_MODLIST="${HOSTS_DIR}/clusterio-host-1/instances/clusterio-host-1-instance-1/mods/mod-list.json"
        if [ -f "${INSTANCE1_MODLIST}" ]; then
            echo "Enabling clusterio_lib and FactorioSurfaceExport in instance 1 mod-list.json"
            python3 <<'PYENABLE1'
import json, sys
with open("${INSTANCE1_MODLIST}", "r") as f:
    mod_list = json.load(f)

# Enable clusterio_lib
found_clusterio = False
for mod in mod_list.get("mods", []):
    if mod["name"] == "clusterio_lib":
        mod["enabled"] = True
        found_clusterio = True
if not found_clusterio:
    mod_list.setdefault("mods", []).append({"name": "clusterio_lib", "enabled": True})

# Enable FactorioSurfaceExport
found_surface = False
for mod in mod_list.get("mods", []):
    if mod["name"] == "FactorioSurfaceExport":
        mod["enabled"] = True
        found_surface = True
if not found_surface:
    mod_list.setdefault("mods", []).append({"name": "FactorioSurfaceExport", "enabled": True})

with open("${INSTANCE1_MODLIST}", "w") as f:
    json.dump(mod_list, f, indent=2)
PYENABLE1
            chown 999:999 "${INSTANCE1_MODLIST}"
            
            # Note: Save patching will inject FactorioSurfaceExport Lua code at startup
            # No mod-list.json validation needed - module is patched from plugin source
        fi
    fi
else
    echo "Skipping assignment for clusterio-host-1-instance-1 (host unavailable)"
fi

if [ "$HOST2_READY" = true ]; then
    echo "Assigning clusterio-host-2-instance-1 to clusterio-host-2..."
    if ! run_quiet "Assign instance 2" timeout 15 npx clusterioctl --log-level error instance assign clusterio-host-2-instance-1 clusterio-host-2; then
        echo "Warning: Could not assign instance 2 (may need to assign manually)"
    else
        # Seed saves into instance directory after assignment
        INSTANCE2_SAVES_DIR="${HOSTS_DIR}/clusterio-host-2/instances/clusterio-host-2-instance-1/saves"
        if [ -d "${SEED_SAVES_DIR}" ] && [ -n "$(ls -A ${SEED_SAVES_DIR} 2>/dev/null)" ]; then
            echo "Seeding saves into ${INSTANCE2_SAVES_DIR}..."
            mkdir -p "${INSTANCE2_SAVES_DIR}"
            cp -n ${SEED_SAVES_DIR}/*.zip "${INSTANCE2_SAVES_DIR}/" 2>/dev/null || true
            
            # Fix permissions (factorio user in host image is uid 999)
            chown -R 999:999 "$(dirname "${INSTANCE2_SAVES_DIR}")"

            echo "Saves seeded for instance 2"

            # Configure to load the specified or newest save
            SAVE_FILE=""
            if [ -n "${INSTANCE2_SAVE_NAME}" ]; then
                # Try to find the specified save file
                if [ -f "${INSTANCE2_SAVES_DIR}/${INSTANCE2_SAVE_NAME}" ]; then
                    SAVE_FILE="${INSTANCE2_SAVES_DIR}/${INSTANCE2_SAVE_NAME}"
                    echo "Using specified save for instance 2: ${INSTANCE2_SAVE_NAME}"
                else
                    echo "Warning: Specified save '${INSTANCE2_SAVE_NAME}' not found for instance 2"
                    echo "Available saves:"
                    ls -1 "${INSTANCE2_SAVES_DIR}"/*.zip 2>/dev/null | xargs -n1 basename || echo "  (none)"
                    echo "Falling back to newest save..."
                fi
            fi
            
            # If no specific save or not found, use the newest save file
            if [ -z "$SAVE_FILE" ]; then
                SAVE_FILE=$(ls -t "${INSTANCE2_SAVES_DIR}"/*.zip 2>/dev/null | head -n 1)
            fi
            
            if [ -n "$SAVE_FILE" ]; then
                SAVE_NAME=$(basename "$SAVE_FILE")
                echo "Seeded save found: $SAVE_NAME"

                # Ensure it has the latest modification time so Clusterio picks it up automatically
                touch "$SAVE_FILE"
                echo "Updated timestamp of $SAVE_NAME to ensure it is selected as the newest save."
            fi
        fi
        
        # Create server-adminlist.json for instance 2
        INSTANCE2_ADMINLIST="${HOSTS_DIR}/clusterio-host-2/instances/clusterio-host-2-instance-1/server-adminlist.json"
        if [ -n "${FACTORIO_ADMINS}" ]; then
            echo "Creating adminlist for instance 2 with admins: ${FACTORIO_ADMINS}"
            mkdir -p "$(dirname "${INSTANCE2_ADMINLIST}")"
            python3 -c "import json, sys; admins=[x.strip() for x in '${FACTORIO_ADMINS}'.split(',') if x.strip()]; json.dump(admins, sys.stdout)" > "${INSTANCE2_ADMINLIST}"
            chown 999:999 "${INSTANCE2_ADMINLIST}"
        fi
        
        # Enable clusterio_lib and FactorioSurfaceExport in mod-list.json for instance 2
        INSTANCE2_MODLIST="${HOSTS_DIR}/clusterio-host-2/instances/clusterio-host-2-instance-1/mods/mod-list.json"
        if [ -f "${INSTANCE2_MODLIST}" ]; then
            echo "Enabling clusterio_lib and FactorioSurfaceExport in instance 2 mod-list.json"
            python3 <<'PYENABLE2'
import json, sys
with open("${INSTANCE2_MODLIST}", "r") as f:
    mod_list = json.load(f)

# Enable clusterio_lib
found_clusterio = False
for mod in mod_list.get("mods", []):
    if mod["name"] == "clusterio_lib":
        mod["enabled"] = True
        found_clusterio = True
if not found_clusterio:
    mod_list.setdefault("mods", []).append({"name": "clusterio_lib", "enabled": True})

# Enable FactorioSurfaceExport
found_surface = False
for mod in mod_list.get("mods", []):
    if mod["name"] == "FactorioSurfaceExport":
        mod["enabled"] = True
        found_surface = True
if not found_surface:
    mod_list.setdefault("mods", []).append({"name": "FactorioSurfaceExport", "enabled": True})

with open("${INSTANCE2_MODLIST}", "w") as f:
    json.dump(mod_list, f, indent=2)
PYENABLE2
            
            # Note: Save patching will inject FactorioSurfaceExport Lua code at startup
            # No mod-list.json validation needed - module is patched from plugin source
            chown 999:999 "${INSTANCE2_MODLIST}"
        fi
    fi
else
    echo "Skipping assignment for clusterio-host-2-instance-1 (host unavailable)"
fi

echo ""
echo "=========================================="
echo "Cluster Initialization Complete!"
echo "=========================================="
echo ""

# Display Component Versions
echo "Component Versions:"
echo "-------------------"

# Clusterio Version
CLUSTERIO_VERSION=$(npx clusterioctl --version 2>/dev/null | head -1 || echo "unknown")
echo "  Clusterio:       $CLUSTERIO_VERSION"

# Factorio Version (from instance or environment)
FACTORIO_VERSION=$(npx clusterioctl --log-level error instance list --json 2>/dev/null | grep -o '"version":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "")
if [ -z "$FACTORIO_VERSION" ] || [ "$FACTORIO_VERSION" = "latest" ]; then
    FACTORIO_VERSION="$MOD_PACK_FACTORIO_VERSION"
fi
echo "  Factorio:        $FACTORIO_VERSION"

# Mod Version (use environment variable)
echo "  Mod:             FactorioSurfaceExport ${SURFACE_EXPORT_MOD_VERSION}"

# Plugin Version (from package.json in seed plugins)
PLUGIN_VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' /opt/seed-plugins/surface-export/package.json 2>/dev/null | head -1 | cut -d'"' -f4 || echo "unknown")
echo "  Plugin:          surface_export $PLUGIN_VERSION"

echo ""

# Extract admin token from config-control.json (created by clusterioctl)
ADMIN_TOKEN=""
if [ -f "$CONFIG_CONTROL" ]; then
    ADMIN_TOKEN=$(grep -o '"control\.controller_token":"[^"]*"' "$CONFIG_CONTROL" 2>/dev/null | cut -d'"' -f4)
fi

if [ -n "$ADMIN_TOKEN" ]; then
    echo "Admin Token:     ${ADMIN_TOKEN}"
else
    echo "Admin Token:     (stored in $CONFIG_CONTROL)"
    echo "                 Use: docker exec clusterio-controller npx clusteriocontroller --log-level error bootstrap generate-user-token admin"
fi

echo ""
echo "Web UI:          http://localhost:${CONTROLLER_HTTP_PORT}"

echo ""
echo "Created:"
echo "  - 2 Instances: clusterio-host-1-instance-1, clusterio-host-2-instance-1"
echo "  - 2 Host configs written to hosts/clusterio-host-1/config-host.json and hosts/clusterio-host-2/config-host.json"
echo "  - Plugin: surface_export_plugin"
echo "  - Mod Pack: my-server-pack"
echo "  - Instances assigned to hosts"
echo ""
echo "Hierarchy:"
echo "  Controller"
echo "    ├─→ clusterio-host-1"
echo "    │     └─→ clusterio-host-1-instance-1 (Game: ${HOST1_INSTANCE1_GAME_PORT}, RCON: ${HOST1_INSTANCE1_RCON_PORT})"
echo "    └─→ clusterio-host-2"
echo "          └─→ clusterio-host-2-instance-1 (Game: ${HOST2_INSTANCE1_GAME_PORT}, RCON: ${HOST2_INSTANCE1_RCON_PORT})"
echo ""

echo "Starting all instances..."
if timeout 30 npx clusterioctl --log-level error instance start-all 2>&1 | grep -v "already running"; then
    echo "All instances started successfully"
else
    echo "Note: Some instances may still be starting (check with 'clusterioctl instance list')"
fi

# Wait for instances to be ready, then unpause game tick
echo "Waiting for instances to initialize..."
sleep 5

echo "Unpausing game tick on all instances..."
for instance_id in 1 2; do
    if npx clusterioctl --log-level error instance send-rcon $instance_id "/c game.tick_paused = false" 2>/dev/null; then
        echo "✓ Instance $instance_id: game tick unpaused"
    else
        echo "⚠ Instance $instance_id: failed to unpause (may not be ready yet)"
    fi
done
echo ""

# =============================================================================
# STEP 9: Install External Plugins
# =============================================================================
echo "=========================================="
echo "Installing External Plugins"
echo "=========================================="

# surface_export: Export/import platforms between instances (from mounted source)
echo "Installing surface_export plugin from /opt/seed-plugins/surface-export..."
if npx clusterioctl plugin add /opt/seed-plugins/surface-export 2>&1 | grep -qE "(Successfully|already)"; then
    echo "✓ surface_export plugin installed"
else
    echo "⚠ Warning: Failed to install surface_export plugin"
fi
echo ""

echo "Cluster initialization complete!"

