ARG BASE_IMAGE
FROM ${BASE_IMAGE}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth xdotool libgl1-mesa-dri libglx-mesa0 libopengl0 libxrandr2 libxi6 libxcursor1 libxinerama1 libasound2 \
    && rm -rf /var/lib/apt/lists/*
ENV LIBGL_ALWAYS_SOFTWARE=1
ENTRYPOINT ["/bin/sh"]
