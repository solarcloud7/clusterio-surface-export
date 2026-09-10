ARG BASE_IMAGE=ghcr.io/solarcloud7/clusterio-docker-host@sha256:98a66d7b39359408ebbb255ff44814b2920ab0fa30596a8a71a872b40df2e232
FROM ${BASE_IMAGE}
ARG ROLE
ARG PACKAGE_SHA256
ARG GATEWAY_SHA256
USER root
WORKDIR /clusterio
COPY package.tgz gateway.zip /release/
RUN echo "$PACKAGE_SHA256  /release/package.tgz" | sha256sum -c - \
    && echo "$GATEWAY_SHA256  /release/gateway.zip" | sha256sum -c - \
    && npm uninstall --omit=dev --no-audit --no-fund \
      @clusterio/plugin-global_chat @clusterio/plugin-inventory_sync @clusterio/plugin-player_auth \
      @clusterio/plugin-research_sync @clusterio/plugin-statistics_exporter @clusterio/plugin-subspace_storage \
    && npm install --omit=dev --no-audit --no-fund /release/package.tgz
COPY verify-install.cjs /release/verify-install.cjs
RUN node /release/verify-install.cjs \
    && mkdir -p /clusterio/seed-data/mods \
    && cp /release/gateway.zip /clusterio/seed-data/mods/surfexp_gateways_0.6.5.zip
COPY --chmod=755 start.sh /release/start.sh
COPY configure-host.cjs configure-controller.cjs wire-startup.cjs settings.json /release/
RUN node /release/wire-startup.cjs "$ROLE"
ENV SURFACE_EXPORT_ROLE=${ROLE}
ENTRYPOINT ["/release/start.sh"]
