ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG ROLE
ARG PACKAGE_SHA256
ARG GATEWAY_SHA256
USER root
WORKDIR /clusterio
COPY package.tgz gateway.zip pins.json verify-gateway.cjs /release/
RUN echo "$PACKAGE_SHA256  /release/package.tgz" | sha256sum -c - \
    && echo "$GATEWAY_SHA256  /release/gateway.zip" | sha256sum -c - \
    && node /release/verify-gateway.cjs \
    && npm uninstall --omit=dev --no-audit --no-fund \
      @clusterio/plugin-global_chat @clusterio/plugin-inventory_sync @clusterio/plugin-player_auth \
      @clusterio/plugin-research_sync @clusterio/plugin-statistics_exporter @clusterio/plugin-subspace_storage \
    && npm install --omit=dev --no-audit --no-fund /release/package.tgz
COPY verify-install.cjs /release/verify-install.cjs
RUN node /release/verify-install.cjs
COPY --chmod=755 start.sh /release/start.sh
COPY configure.cjs configure-host.cjs configure-controller.cjs wire-startup.cjs settings.json /release/
RUN node /release/wire-startup.cjs "$ROLE"
ENV SURFACE_EXPORT_ROLE=${ROLE}
ENTRYPOINT ["/release/start.sh"]
