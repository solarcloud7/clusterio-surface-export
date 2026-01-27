#!/bin/bash
# Installs the official Factorio Space Age expansion archive into the mods directory.
# Downloads directly from factorio.com using the player's credentials (never redistributes binaries).

set -euo pipefail

MOD_NAME="space-age"
MODS_DIR=${SPACE_AGE_INSTALL_DIR:-/factorio/mods}
REQUEST_VERSION=${SPACE_AGE_VERSION:-latest}
FORCE_DOWNLOAD=${SPACE_AGE_FORCE_DOWNLOAD:-false}
CURL_RETRIES=${SPACE_AGE_CURL_RETRIES:-3}

log() {
    echo "[space-age] $*"
}

warn() {
    >&2 echo "[space-age][warn] $*"
}

trim_value() {
    local value="$1"
    # Strip leading whitespace
    value="${value#${value%%[![:space:]]*}}"
    # Strip trailing whitespace
    value="${value%${value##*[![:space:]]}}"
    if [ "${#value}" -ge 2 ] && [ "${value:0:1}" = '"' ] && [ "${value: -1}" = '"' ]; then
        value="${value:1:-1}"
    fi
    echo "$value"
}

USERNAME=$(trim_value "${FACTORIO_USERNAME:-}")
TOKEN=$(trim_value "${FACTORIO_TOKEN:-}")

if ! command -v curl >/dev/null 2>&1; then
    warn "curl not available; cannot download Space Age archive"
    exit 1
fi

if [ -z "$USERNAME" ] || [ -z "$TOKEN" ]; then
    log "FACTORIO_USERNAME or FACTORIO_TOKEN missing; skipping Space Age download"
    exit 0
fi

mkdir -p "$MODS_DIR"

existing_zip=""
if [ -d "$MODS_DIR" ]; then
    existing_zip=$(find "$MODS_DIR" -maxdepth 1 -type f -name "${MOD_NAME}_*.zip" | sort | tail -n 1 || true)
fi

if [ -n "$existing_zip" ] && [ "${FORCE_DOWNLOAD,,}" != "true" ]; then
    basename_existing=$(basename "$existing_zip")
    if [ "$REQUEST_VERSION" = "latest" ] || [[ "$basename_existing" == "${MOD_NAME}_${REQUEST_VERSION}.zip" ]]; then
        log "Space Age archive already present (${basename_existing}); skipping download"
        exit 0
    fi
fi

REQUESTED_TAG=${REQUEST_VERSION// /}
DOWNLOAD_URL="https://factorio.com/get-download/${MOD_NAME}/${REQUESTED_TAG}?username=${USERNAME}&token=${TOKEN}"

headers_file=$(mktemp)
tmp_archive=$(mktemp)
cleanup() {
    rm -f "$headers_file" "$tmp_archive"
}
trap cleanup EXIT

log "Downloading Space Age (${REQUEST_VERSION}) from factorio.com"
if ! curl -fsSL --retry "$CURL_RETRIES" --retry-delay 2 \
    -D "$headers_file" -o "$tmp_archive" "$DOWNLOAD_URL"; then
    warn "Failed to download Space Age archive; check credentials and internet connectivity"
    exit 1
fi

status_code=$(head -n 1 "$headers_file" | awk '{print $2}')
if [ "$status_code" != "200" ]; then
    warn "factorio.com returned status ${status_code} for ${REQUEST_VERSION}; see ${headers_file}"
    exit 1
fi

header_filename=$(grep -i "content-disposition" "$headers_file" | tail -n 1 | sed -n "s/.*filename=\"\?\\?\([^\";]*\).*/\1/p")
if [ -z "$header_filename" ]; then
    if [ "$REQUEST_VERSION" = "latest" ]; then
        header_filename="${MOD_NAME}_download.zip"
    else
        header_filename="${MOD_NAME}_${REQUEST_VERSION}.zip"
    fi
fi

target_path="${MODS_DIR}/${header_filename}"
log "Saving Space Age archive to ${target_path}"
if [ -f "$target_path" ]; then
    log "Overwriting existing archive ${header_filename}"
fi
mv "$tmp_archive" "$target_path"

if id -u factorio >/dev/null 2>&1; then
    chown factorio:factorio "$target_path"
fi

log "Space Age archive ready: ${target_path}"
trap - EXIT
rm -f "$headers_file"
exit 0
