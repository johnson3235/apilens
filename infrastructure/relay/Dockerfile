# ApiLens relay: records and mocks the calls a backend (JCS) makes to TMF, OSB, Vesta…
# Build from the release tarball, next to this file:
#   curl -LO https://github.com/johnson3235/apilens/releases/download/next-sdk-v0.6.0/apilens-next-sdk-0.6.0.tgz
#   docker build -t apilens-relay:0.6.0 .
FROM node:20-alpine
WORKDIR /relay
COPY apilens-next-sdk-*.tgz ./
# The package has no runtime dependencies.
RUN npm install --omit=dev --no-save --no-audit --no-fund ./apilens-next-sdk-*.tgz && rm apilens-next-sdk-*.tgz
USER node
ENV PORT=8080 NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/__relay/health || exit 1
CMD ["node", "node_modules/@apilens/next-sdk/dist/relay-cli.js"]
