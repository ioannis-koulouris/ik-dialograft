# Short-lived coding container: Qwen Code + preinstalled dependencies matching package-lock.json.
# Build from the repository root: docker build -f docker/coder.Dockerfile -t dialograft-coder:local .
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/* \
 && npm install -g @qwen-code/qwen-code@0.26.4 \
 && useradd -m -u 1000 -s /bin/bash agent 2>/dev/null || true
WORKDIR /opt/deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && sha256sum package-lock.json > /opt/deps/lock.sha256
COPY docker/coder-entrypoint.sh /usr/local/bin/coder
RUN chmod 755 /usr/local/bin/coder
ENV HOME=/home/agent
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/coder"]
