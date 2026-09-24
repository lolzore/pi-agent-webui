# Pi Agent WebUI — runs the pi coding agent in RPC mode and serves the browser UI.
FROM node:22-bookworm-slim

# git is useful for the agent's repo tools; ca-certs for API calls
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
 && rm -rf /var/lib/apt/lists/*

# Which pi the container runs. The default matches the package this WebUI is
# developed against; @mariozechner/pi-coding-agent (the original pi-mono
# package) works as well. Built as an argument so a build can pick a different
# one without editing the file. @latest is left out on purpose: the RPC surface
# is what the bridge talks to, and a silent major bump should not be able to
# break an image that used to build.
ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_VERSION=latest
RUN npm install -g "${PI_PACKAGE}@${PI_VERSION}"

WORKDIR /app
COPY bridge/package.json bridge/package-lock.json /app/bridge/
RUN cd /app/bridge && (npm ci --omit=dev || npm install --omit=dev)
COPY bridge /app/bridge
COPY web /app/web

# Bind every interface inside the container: Docker forwards a published port to
# the container's address, never to its loopback, so the default 127.0.0.1 left
# `docker compose up` serving a UI that could not connect. The port mapping, not
# the bridge, is the boundary here.
ENV PI_WEBUI_HOST=0.0.0.0     PORT=3000 \
    WORKSPACE_DIR=/workspace \
    PI_SESSION_DIR=/root/.pi/agent/sessions \
    PI_COMMAND="pi --mode rpc"

EXPOSE 3000
WORKDIR /workspace
CMD ["node", "/app/bridge/server.js"]
