# Upstream Change: Runtime Factorio Client Download

> **STATUS: IMPLEMENTED** — Merged in [clusterio-docker v1.1.0](https://github.com/solarcloud7/clusterio-docker/releases/tag/v1.1.0). The runtime download is live in the GHCR images. Additionally, the client is now stored in an **external `factorio-client` Docker volume** (not the host data volume) so it persists across `docker compose down -v` and is shared between projects.

## Problem

The Factorio game client (non-headless) cannot be distributed in a public Docker image due to
Factorio's licensing terms. The current `Dockerfile.host` supports `INSTALL_FACTORIO_CLIENT=true`
as a **build-time** arg, but this requires credentials at image build time and bakes the client
into the image — making it impossible to publish to GHCR for general use.

## Solution

Move client download from build time to **runtime** in `host-entrypoint.sh`. If the user provides
`FACTORIO_USERNAME` and `FACTORIO_TOKEN` environment variables and the client is not already
present, download it on first container startup into the persistent data volume.

The downloaded client persists across restarts (lives in the volume, not the image layer), so the
download only happens once.

## Changes Required

### 1. `scripts/host-entrypoint.sh`

Add a runtime client download block **before** the `FACTORIO_DIR` selection logic (around the
existing "Determine which Factorio installation to use" comment):

```bash
# Runtime Factorio client download.
# If FACTORIO_USERNAME + FACTORIO_TOKEN are set and the client is not already installed,
# download it now. The client is stored in the data volume so it persists across restarts.
FACTORIO_CLIENT_HOME="${FACTORIO_CLIENT_HOME:-/opt/factorio-client}"
FACTORIO_CLIENT_VOLUME_DIR="$DATA_DIR/factorio-client"

if [ ! -d "$FACTORIO_CLIENT_HOME" ] && [ ! -d "$FACTORIO_CLIENT_VOLUME_DIR" ] \
   && [ -n "$FACTORIO_USERNAME" ] && [ -n "$FACTORIO_TOKEN" ]; then
  FACTORIO_CLIENT_BUILD="${FACTORIO_CLIENT_BUILD:-expansion}"
  FACTORIO_CLIENT_TAG="${FACTORIO_CLIENT_TAG:-stable}"
  echo "Downloading Factorio game client (build=${FACTORIO_CLIENT_BUILD}, tag=${FACTORIO_CLIENT_TAG})..."
  archive="/tmp/factorio-client.tar.xz"
  curl -fL --retry 8 \
    "https://factorio.com/get-download/${FACTORIO_CLIENT_TAG}/${FACTORIO_CLIENT_BUILD}/linux64?username=${FACTORIO_USERNAME}&token=${FACTORIO_TOKEN}" \
    -o "$archive"
  mkdir -p "$FACTORIO_CLIENT_VOLUME_DIR"
  tar -xJf "$archive" -C "$FACTORIO_CLIENT_VOLUME_DIR" --strip-components=1
  rm "$archive"
  chown -R clusterio:clusterio "$FACTORIO_CLIENT_VOLUME_DIR"
  echo "Factorio game client installed to $FACTORIO_CLIENT_VOLUME_DIR"
fi

# Use volume-installed client if present (preferred), then image-baked client, then headless.
if [ -d "$FACTORIO_CLIENT_VOLUME_DIR" ] && [ "${SKIP_CLIENT:-false}" != "true" ]; then
    FACTORIO_DIR="$FACTORIO_CLIENT_VOLUME_DIR"
    echo "Factorio game client (volume) detected — using $FACTORIO_DIR"
elif [ -d "$FACTORIO_CLIENT_HOME" ] && [ "${SKIP_CLIENT:-false}" != "true" ]; then
    FACTORIO_DIR="$FACTORIO_CLIENT_HOME"
    echo "Factorio game client (image) detected — using $FACTORIO_DIR"
else
    FACTORIO_DIR="$FACTORIO_HOME"
fi
```

**Replace** the existing "Determine which Factorio installation to use" block (which currently
only handles the image-baked client) with the above.

### 2. `Dockerfile.host`

No changes required. The `INSTALL_FACTORIO_CLIENT` build arg remains available for users who
want to bake the client into a private image. The default stays `false` so the public GHCR image
is unaffected.

### 3. `.env.example`

Document the new runtime env vars:

```dotenv
# Factorio Account (required for runtime client download on hosts with SKIP_CLIENT=false)
# Get your token from https://factorio.com/profile
# FACTORIO_USERNAME=
# FACTORIO_TOKEN=

# Optional: Factorio client build type for runtime download (default: expansion = Space Age)
# FACTORIO_CLIENT_BUILD=expansion

# Set SKIP_CLIENT=true on a host to force headless even if credentials are present
# SKIP_CLIENT=false
```

## How It Works After This Change

1. User sets `FACTORIO_USERNAME` and `FACTORIO_TOKEN` in their `.env`
2. Host container starts — entrypoint detects no client present + credentials available
3. Client is downloaded once (~1-2 min) and extracted to `$DATA_DIR/factorio-client` (the
   persistent data volume)
4. On all subsequent restarts the volume directory is detected immediately — no re-download
5. `SKIP_CLIENT=true` can be set on specific hosts to force headless regardless of credentials

## Usage in `docker-compose.yml` (Consumer Repos)

```yaml
surface-export-host-1:
  image: ghcr.io/solarcloud7/clusterio-docker-host  # standard pre-built image
  environment:
    - FACTORIO_USERNAME=${FACTORIO_USERNAME}
    - FACTORIO_TOKEN=${FACTORIO_TOKEN}
    - FACTORIO_CLIENT_BUILD=expansion   # Space Age (default after this change)
```

Host 2 (headless, no credentials needed):
```yaml
surface-export-host-2:
  image: ghcr.io/solarcloud7/clusterio-docker-host
  environment:
    - SKIP_CLIENT=true   # or just don't set credentials
```

## Notes

- `FACTORIO_CLIENT_BUILD=expansion` downloads Space Age (includes base game). Use `alpha` for
  base game only.
- The download URL requires a valid factorio.com account with the relevant DLC purchased.
- Credentials are only passed as runtime env vars — they never appear in `docker history` or
  image layers.
- The existing `INSTALL_FACTORIO_CLIENT` build-arg path is preserved for users running private
  registries who prefer baking the client in.
