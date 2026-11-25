# dsh-collab-hub — zero-dependency Node service.
# Build:  docker build -t dsh-collab-hub:0.3.0 .
# Run:    docker run -d --name dsh-collab-hub -p 8787:8787 -v hub-data:/data dsh-collab-hub:0.3.0
FROM node:24-slim

LABEL org.opencontainers.image.title="dsh-collab-hub"
LABEL org.opencontainers.image.description="Intranet collaboration hub for DSH process teams"
LABEL org.opencontainers.image.version="0.3.0"

ENV NODE_ENV=production
WORKDIR /app

# Runtime files only; there are no npm dependencies to install.
COPY --chown=node:node package.json README.md LICENSE ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node mcp ./mcp

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "bin/collab.mjs", "hub", "--host", "0.0.0.0", "--port", "8787", "--data", "/data"]
