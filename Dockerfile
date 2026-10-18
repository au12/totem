# Gottlieb's Totem (1979) for the browser.
#
#   docker build -t totem .
#   docker run -p 8080:8080 -v /path/to/totem:/data:ro -v totem:/config totem
#
# Build stages run on the build machine's own architecture (the front end is
# architecture-independent; Go cross-compiles), so a multi-arch image builds
# quickly without emulation.

ARG NODE_VERSION=22
ARG GO_VERSION=1.24

# --- 1. Front end ----------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
ARG VERSION=dev
RUN VERSION="$VERSION" node build.mjs

# --- 2. Server --------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS server
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev
WORKDIR /src
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/totem . \
 && mkdir -p /out/rootfs/config /out/rootfs/data /out/rootfs/tmp \
 && chmod 1777 /out/rootfs/tmp

# --- 3. Runtime: one static binary and the built site ----------------------------
FROM scratch
COPY --from=server /out/rootfs/ /
COPY --from=server /out/totem /totem
COPY --from=web /web/dist/ /www/
ENV PORT=8080 \
    WEB_ROOT=/www \
    DATA_DIR=/data \
    STATE_DIR=/config \
    PUID=1000 \
    PGID=1000 \
    TMPDIR=/tmp
EXPOSE 8080
VOLUME ["/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/totem", "-healthcheck"]
ENTRYPOINT ["/totem"]
