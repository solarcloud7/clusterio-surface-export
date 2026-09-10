FROM node@sha256:bf22df20270b654c4e9da59d8d4a3516cce6ba2852e159b27288d645b7a7eedc
# Test runner only: the standalone interpreter used by CI, not Factorio's modified
# Lua runtime. It does not reproduce Factorio's sandbox, loader or engine APIs.
RUN apt-get update && apt-get install -y --no-install-recommends lua5.2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
ENTRYPOINT ["lua5.2"]
