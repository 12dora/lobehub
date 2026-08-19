## Set global build ENV
## Pinned to a Node MINOR line, not the floating major: the browser-device profile
## re-derives timezone offsets and long zone names from the runtime's own ICU/tzdata,
## so a silent Node bump can change what the profile presents upstream. No digest —
## patch releases still land automatically for security fixes.
ARG NODEJS_VERSION="24.19"

## Base image for all building stages
FROM node:${NODEJS_VERSION}-slim AS base

ARG USE_CN_MIRROR

## curl-impersonate: the ChatGPT Web provider transport. chatgpt.com is behind
## Cloudflare bot-fight and answers Node's own fetch with a 403 challenge whatever
## headers it sends — the TLS/HTTP2 fingerprint is what gets checked. The musl assets
## are STATICALLY linked, so the binary runs in the busybox/scratch runtime image.
## Version + digests are pinned in scripts/curlImpersonate/manifest.json (the single
## source of truth, read by the dev installer). A shell build stage cannot read JSON, so
## the two linux/musl binary digests and the two linux-gnu library digests are
## duplicated here — change them together.
ARG CURL_IMPERSONATE_VERSION="v2.1.0"
ARG CURL_IMPERSONATE_DOWNLOAD_BASE=""
ARG CURL_IMPERSONATE_SHA256_AARCH64="e6dea0ce4fe5d6e7f01c1926c2b3bf6bbd140e1b890c0788881a10bfc09b25e2"
ARG CURL_IMPERSONATE_SHA256_X86_64="4fb112bd537ab701c197506b7a06d6711a564f8338dac30a8862683b9f7107e9"
## libcurl-impersonate: in-process persistent HTTP/2 transport loaded via koffi.
## linux-gnu .so (glibc ≥ 2.17 is what node:slim ships; the .so itself needs ≥ 2.7;
## BoringSSL/nghttp2/brotli/zstd are statically inside).
ARG LIBCURL_IMPERSONATE_SHA256_AARCH64="b0c62ee0523b982470bf624fc8d60fdebe62ca5974fa3d9362b7bf204b3d5439"
ARG LIBCURL_IMPERSONATE_SHA256_X86_64="ab6ab7c0a36a8dde1197349440e43e35c6bdf909e8fb8f218036660e05a37225"

## Cursor Agent CLI: the Cursor provider transport. Distroless has no bash, so the
## server spawns `<home>/node --use-system-ca <home>/index.js` with
## CURSOR_INVOKED_AS=cursor-agent rather than the bash launcher. downloads.cursor.com
## is Cloudflare; no CN mirror is used. Digests recorded from the 2026.08.11-e8db854
## linux tarballs (sha256sum of agent-cli-package.tar.gz).
ARG CURSOR_AGENT_VERSION="2026.08.11-e8db854"
ARG CURSOR_AGENT_SHA256_X64="bfff4bf6f4e9dd30c1d0ef0a70b6077b074015dd2948e4c50685d53afdcfce5a"
ARG CURSOR_AGENT_SHA256_ARM64="ea13f92e295f523a99ce8d8f57d6894d21e5d1e2d030ffad718ccd5955ca2eed"

ENV DEBIAN_FRONTEND="noninteractive"

RUN set -e && \
    if [ "${USE_CN_MIRROR:-false}" = "true" ]; then \
        sed -i "s/deb.debian.org/mirrors.ustc.edu.cn/g" "/etc/apt/sources.list.d/debian.sources"; \
    fi && \
    apt update && \
    apt install ca-certificates curl proxychains-ng -qy && \
    mkdir -p /distroless/bin /distroless/etc /distroless/etc/ssl/certs /distroless/lib && \
    cp /usr/lib/$(arch)-linux-gnu/libproxychains.so.4 /distroless/lib/libproxychains.so.4 && \
    cp /usr/lib/$(arch)-linux-gnu/libdl.so.2 /distroless/lib/libdl.so.2 && \
    cp /usr/bin/proxychains4 /distroless/bin/proxychains && \
    cp /etc/proxychains4.conf /distroless/etc/proxychains4.conf && \
    cp /usr/lib/$(arch)-linux-gnu/libstdc++.so.6 /distroless/lib/libstdc++.so.6 && \
    ## zlib: the Cursor Agent CLI's file_service addon links libz.so.1 dynamically
    cp /usr/lib/$(arch)-linux-gnu/libz.so.1 /distroless/lib/libz.so.1 && \
    cp /usr/lib/$(arch)-linux-gnu/libgcc_s.so.1 /distroless/lib/libgcc_s.so.1 && \
    cp /usr/lib/$(arch)-linux-gnu/librt.so.1 /distroless/lib/librt.so.1 && \
    ## libcurl-impersonate.so NEEDs libpthread.so.0 / libc.so.6 / libdl.so.2 (+ the
    ## ld-linux loader). The busybox:glibc runtime image already ships all of them
    ## (its own glibc — 2.41 at the time of writing — newer than node:slim's 2.36), and
    ## node itself runs on that libc. Do NOT copy libc.so.6 / libpthread / ld-linux from
    ## node:slim here: mixing an older libc.so.6 with the runtime's libm/libresolv/libnss
    ## breaks every dynamically linked binary in the final image (GLIBC_PRIVATE mismatch).
    cp /usr/local/bin/node /distroless/bin/node && \
    cp /etc/ssl/certs/ca-certificates.crt /distroless/etc/ssl/certs/ca-certificates.crt && \
    rm -rf /tmp/* /var/lib/apt/lists/* /var/tmp/*

RUN set -e && \
    CURL_IMPERSONATE_BASE="${CURL_IMPERSONATE_DOWNLOAD_BASE}"; \
    if [ -z "${CURL_IMPERSONATE_BASE}" ]; then \
        if [ "${USE_CN_MIRROR:-false}" = "true" ]; then \
            CURL_IMPERSONATE_BASE="https://ghfast.top/https://github.com/lexiforest/curl-impersonate/releases/download"; \
        else \
            CURL_IMPERSONATE_BASE="https://github.com/lexiforest/curl-impersonate/releases/download"; \
        fi; \
    fi; \
    case "$(arch)" in \
        x86_64) CURL_IMPERSONATE_ARCH="x86_64-linux-musl"; CURL_IMPERSONATE_SHA256="${CURL_IMPERSONATE_SHA256_X86_64}" ;; \
        aarch64|arm64) CURL_IMPERSONATE_ARCH="aarch64-linux-musl"; CURL_IMPERSONATE_SHA256="${CURL_IMPERSONATE_SHA256_AARCH64}" ;; \
        *) echo "curl-impersonate: unsupported architecture $(arch)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /distroless/usr/local/bin /tmp/curl-impersonate && \
    curl -fsSL "${CURL_IMPERSONATE_BASE}/${CURL_IMPERSONATE_VERSION}/curl-impersonate-${CURL_IMPERSONATE_VERSION}.${CURL_IMPERSONATE_ARCH}.tar.gz" \
        -o /tmp/curl-impersonate/curl-impersonate.tar.gz && \
    ## Fail closed on anything but the reviewed release: HTTPS says who served the file,
    ## not that it is the file we pinned — and this binary runs with the server's secrets.
    echo "${CURL_IMPERSONATE_SHA256}  /tmp/curl-impersonate/curl-impersonate.tar.gz" | sha256sum -c - && \
    ## Stage, then assert a REGULAR file (a symlink entry would install a pointer at
    ## something else), then install atomically.
    tar -xzf /tmp/curl-impersonate/curl-impersonate.tar.gz -C /tmp/curl-impersonate curl-impersonate && \
    test -f /tmp/curl-impersonate/curl-impersonate && test ! -L /tmp/curl-impersonate/curl-impersonate && \
    chmod 755 /tmp/curl-impersonate/curl-impersonate && \
    /tmp/curl-impersonate/curl-impersonate --version | head -n 1 && \
    mv -f /tmp/curl-impersonate/curl-impersonate /distroless/usr/local/bin/curl-impersonate && \
    rm -rf /tmp/curl-impersonate

## libcurl-impersonate.so: same release as the CLI binary, gnu (not musl) so koffi
## can dlopen it. The app stage `COPY --from=base /distroless/` and the layer-a
## catch-all (`cp -a /usr`) both carry `/usr/local/lib` into the final image.
RUN set -e && \
    CURL_IMPERSONATE_BASE="${CURL_IMPERSONATE_DOWNLOAD_BASE}"; \
    if [ -z "${CURL_IMPERSONATE_BASE}" ]; then \
        if [ "${USE_CN_MIRROR:-false}" = "true" ]; then \
            CURL_IMPERSONATE_BASE="https://ghfast.top/https://github.com/lexiforest/curl-impersonate/releases/download"; \
        else \
            CURL_IMPERSONATE_BASE="https://github.com/lexiforest/curl-impersonate/releases/download"; \
        fi; \
    fi; \
    case "$(arch)" in \
        x86_64) LIBCURL_IMPERSONATE_ARCH="x86_64-linux-gnu"; LIBCURL_IMPERSONATE_SHA256="${LIBCURL_IMPERSONATE_SHA256_X86_64}" ;; \
        aarch64|arm64) LIBCURL_IMPERSONATE_ARCH="aarch64-linux-gnu"; LIBCURL_IMPERSONATE_SHA256="${LIBCURL_IMPERSONATE_SHA256_AARCH64}" ;; \
        *) echo "libcurl-impersonate: unsupported architecture $(arch)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /distroless/usr/local/lib /tmp/libcurl-impersonate && \
    curl -fsSL "${CURL_IMPERSONATE_BASE}/${CURL_IMPERSONATE_VERSION}/libcurl-impersonate-${CURL_IMPERSONATE_VERSION}.${LIBCURL_IMPERSONATE_ARCH}.tar.gz" \
        -o /tmp/libcurl-impersonate/libcurl-impersonate.tar.gz && \
    ## Fail closed on anything but the reviewed release.
    echo "${LIBCURL_IMPERSONATE_SHA256}  /tmp/libcurl-impersonate/libcurl-impersonate.tar.gz" | sha256sum -c - && \
    ## Extract the REAL .so.4.8.0 (not the .so / .so.4 symlinks), install as a
    ## regular file named libcurl-impersonate.so.
    tar -xzf /tmp/libcurl-impersonate/libcurl-impersonate.tar.gz -C /tmp/libcurl-impersonate libcurl-impersonate.so.4.8.0 && \
    test -f /tmp/libcurl-impersonate/libcurl-impersonate.so.4.8.0 && test ! -L /tmp/libcurl-impersonate/libcurl-impersonate.so.4.8.0 && \
    chmod 755 /tmp/libcurl-impersonate/libcurl-impersonate.so.4.8.0 && \
    mv -f /tmp/libcurl-impersonate/libcurl-impersonate.so.4.8.0 /distroless/usr/local/lib/libcurl-impersonate.so && \
    test -f /distroless/usr/local/lib/libcurl-impersonate.so && test ! -L /distroless/usr/local/lib/libcurl-impersonate.so && \
    ldd /distroless/usr/local/lib/libcurl-impersonate.so | tee /tmp/libcurl-impersonate.ldd && \
    if grep -q 'not found' /tmp/libcurl-impersonate.ldd; then \
        echo "libcurl-impersonate: unresolved NEEDED (see ldd above)" >&2; \
        exit 1; \
    fi && \
    rm -rf /tmp/libcurl-impersonate /tmp/libcurl-impersonate.ldd

RUN set -e && \
    case "$(arch)" in \
        x86_64) CURSOR_AGENT_ARCH="x64"; CURSOR_AGENT_SHA256="${CURSOR_AGENT_SHA256_X64}" ;; \
        aarch64|arm64) CURSOR_AGENT_ARCH="arm64"; CURSOR_AGENT_SHA256="${CURSOR_AGENT_SHA256_ARM64}" ;; \
        *) echo "cursor-agent: unsupported architecture $(arch)" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tmp/cursor-agent /distroless/opt/cursor-agent && \
    curl -fsSL "https://downloads.cursor.com/lab/${CURSOR_AGENT_VERSION}/linux/${CURSOR_AGENT_ARCH}/agent-cli-package.tar.gz" \
        -o /tmp/cursor-agent/agent-cli-package.tar.gz && \
    ## Fail closed on anything but the reviewed release: HTTPS says who served the file,
    ## not that it is the file we pinned — and this binary runs with the server's secrets.
    echo "${CURSOR_AGENT_SHA256}  /tmp/cursor-agent/agent-cli-package.tar.gz" | sha256sum -c - && \
    ## Extract dist-package/ onto /opt/cursor-agent (strip the dist-package/ prefix).
    ## Keep tarball file modes; do not rewrite them or plant a launcher symlink —
    ## distroless has no bash, so the server execs node index.js directly.
    tar -xzf /tmp/cursor-agent/agent-cli-package.tar.gz -C /distroless/opt/cursor-agent --strip-components=1 && \
    test -f /distroless/opt/cursor-agent/index.js && test ! -L /distroless/opt/cursor-agent/index.js && \
    test -f /distroless/opt/cursor-agent/node && test ! -L /distroless/opt/cursor-agent/node && \
    /distroless/opt/cursor-agent/node --version && \
    rm -rf /tmp/cursor-agent

## Builder image, install all the dependencies and build the app
FROM base AS builder

ARG USE_CN_MIRROR
ARG NEXT_PUBLIC_BASE_PATH
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_ANALYTICS_POSTHOG
ARG NEXT_PUBLIC_POSTHOG_HOST
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_ANALYTICS_UMAMI
ARG NEXT_PUBLIC_UMAMI_SCRIPT_URL
ARG NEXT_PUBLIC_UMAMI_WEBSITE_ID
ARG FEATURE_FLAGS

ENV NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH}" \
    FEATURE_FLAGS="${FEATURE_FLAGS}"

ENV APP_URL="http://app.com" \
    DATABASE_DRIVER="node" \
    DATABASE_URL="postgres://postgres:password@localhost:5432/postgres" \
    KEY_VAULTS_SECRET="use-for-build" \
    AUTH_SECRET="use-for-build"

# Sentry
ENV NEXT_PUBLIC_SENTRY_DSN="${NEXT_PUBLIC_SENTRY_DSN}" \
    SENTRY_ORG="" \
    SENTRY_PROJECT=""

# Posthog
ENV NEXT_PUBLIC_ANALYTICS_POSTHOG="${NEXT_PUBLIC_ANALYTICS_POSTHOG}" \
    NEXT_PUBLIC_POSTHOG_HOST="${NEXT_PUBLIC_POSTHOG_HOST}" \
    NEXT_PUBLIC_POSTHOG_KEY="${NEXT_PUBLIC_POSTHOG_KEY}"

# Umami
ENV NEXT_PUBLIC_ANALYTICS_UMAMI="${NEXT_PUBLIC_ANALYTICS_UMAMI}" \
    NEXT_PUBLIC_UMAMI_SCRIPT_URL="${NEXT_PUBLIC_UMAMI_SCRIPT_URL}" \
    NEXT_PUBLIC_UMAMI_WEBSITE_ID="${NEXT_PUBLIC_UMAMI_WEBSITE_ID}"

# Node
ENV NODE_OPTIONS="--max-old-space-size=8192"

WORKDIR /app

COPY package.json pnpm-workspace.yaml ./
COPY .npmrc ./
COPY packages ./packages
COPY patches ./patches
# bring in desktop workspace manifest so pnpm can resolve it
COPY apps/desktop/src/main/package.json ./apps/desktop/src/main/package.json

RUN set -e && \
    if [ "${USE_CN_MIRROR:-false}" = "true" ]; then \
        export SENTRYCLI_CDNURL="https://npmmirror.com/mirrors/sentry-cli"; \
        npm config set registry "https://registry.npmmirror.com/"; \
        echo 'canvas_binary_host_mirror=https://npmmirror.com/mirrors/canvas' >> .npmrc; \
    fi && \
    export COREPACK_NPM_REGISTRY=$(npm config get registry | sed 's/\/$//') && \
    npm i -g corepack@latest && \
    corepack enable && \
    corepack use $(sed -n 's/.*"packageManager": "\(.*\)".*/\1/p' package.json) && \
    pnpm i && \
    mkdir -p /deps && \
    cd /deps && \
    echo '{"name":"deps","private":true}' > package.json && \
    pnpm add pg drizzle-orm

COPY . .

# Prebuild: env checks (checkDeprecatedAuth, checkRequiredEnvVars, printEnvInfo) then remove desktop-only code
RUN pnpm exec tsx scripts/dockerPrebuild.mts
RUN rm -rf src/app/desktop "src/app/(backend)/trpc/desktop"

# run build standalone for docker version
RUN npm run build:docker

## Application image, copy all the files for production
FROM busybox:latest AS app

COPY --from=base /distroless/ /

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder /app/.next/standalone /app/
COPY --from=builder /app/.next/static /app/.next/static
# Copy SPA assets (Vite build output)
COPY --from=builder /app/public/_spa /app/public/_spa
# Copy database migrations
COPY --from=builder /app/packages/database/migrations /app/migrations
COPY --from=builder /app/scripts/migrateServerDB/docker.cjs /app/docker.cjs
COPY --from=builder /app/scripts/migrateServerDB/errorHint.js /app/errorHint.js

# copy dependencies
COPY --from=builder /deps/node_modules/.pnpm /app/node_modules/.pnpm
COPY --from=builder /deps/node_modules/pg /app/node_modules/pg
COPY --from=builder /deps/node_modules/drizzle-orm /app/node_modules/drizzle-orm

# Copy server launcher and shared scripts
COPY --from=builder /app/scripts/serverLauncher/startServer.js /app/startServer.js
COPY --from=builder /app/scripts/_shared /app/scripts/_shared

# @vitejs/devtools is a build-time leak (require.resolve fails at runtime).
# Extra @napi-rs/canvas skia.node copies under .pnpm are byte-identical to the
# hoisted /app/node_modules/@napi-rs/canvas-linux-* that require() resolves.
RUN find /app/node_modules/.pnpm -maxdepth 1 -name '@vitejs+devtools*' -exec rm -rf {} + || true && \
    find /app/node_modules/.pnpm -name 'skia*.node' -type f -delete || true

RUN set -e && \
    addgroup -S -g 1001 nodejs && \
    adduser -D -G nodejs -H -S -h /app -u 1001 nextjs && \
    chown -R nextjs:nodejs /app /etc/proxychains4.conf && \
    mkdir -p /layer-a/bin /layer-a/app /layer-b/app && \
    for p in /* /.[!.]*; do \
      case "$p" in \
        /app|/bin|/proc|/sys|/dev|/layer-a|/layer-b) continue ;; \
      esac; \
      [ -e "$p" ] || [ -L "$p" ] || continue; \
      cp -a "$p" /layer-a/; \
    done && \
    cp -a /bin/node /bin/proxychains /bin/busybox /layer-a/bin/ && \
    for a in $(/bin/busybox --list); do \
      [ -e "/layer-a/bin/$a" ] || ln -s busybox "/layer-a/bin/$a"; \
    done && \
    if [ -f /bin/getconf ] && [ ! -e /layer-a/bin/getconf ]; then \
      cp -a /bin/getconf /layer-a/bin/getconf; \
    fi && \
    mkdir -m 1777 -p /layer-a/tmp && \
    chmod 1777 /layer-a/tmp && \
    cp -al /app/node_modules /layer-a/app/node_modules && \
    for p in /app/* /app/.[!.]*; do \
      [ -e "$p" ] || continue; \
      [ "$(basename "$p")" = "node_modules" ] && continue; \
      cp -al "$p" /layer-b/app/; \
    done && \
    chown nextjs:nodejs /layer-a/app /layer-b/app

## Production image, copy all the files and run next
FROM scratch

# Two cacheable layers: (a) OS + node_modules, (b) app payload.
# A source-only rebuild should reuse layer (a).
COPY --from=app /layer-a /
COPY --from=app /layer-b /

ENV NODE_ENV="production" \
    NODE_OPTIONS="--dns-result-order=ipv4first --use-openssl-ca" \
    NODE_EXTRA_CA_CERTS="" \
    NODE_TLS_REJECT_UNAUTHORIZED="" \
    SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"

# Make the middleware rewrite through local as default
# refs: https://github.com/lobehub/lobehub/issues/5876
ENV MIDDLEWARE_REWRITE_THROUGH_LOCAL="1"

# set hostname to localhost
ENV HOSTNAME="0.0.0.0" \
    PORT="3210"

# General Variables
ENV APP_URL="" \
    API_KEY_SELECT_MODE="" \
    DEFAULT_AGENT_CONFIG="" \
    SYSTEM_AGENT="" \
    FEATURE_FLAGS="" \
    PROXY_URL="" \
    LOBE_MODULE_PRESET="" \
    LOBE_MODULES_DISABLED="" \
    LOBE_NODE_HEAP_MB="" \
    ENABLE_BOT_GATEWAY="" \
    SKIP_DB_MIGRATION=""

# ChatGPT Web provider transport (browser-fingerprinted curl, shipped in this image)
ENV CHATGPT_WEB_CURL_IMPERSONATE_BIN="/usr/local/bin/curl-impersonate" \
    CHATGPT_WEB_LIBCURL_IMPERSONATE_PATH="/usr/local/lib/libcurl-impersonate.so" \
    CHATGPT_WEB_ALLOWED_HOSTS=""

# Cursor provider transport (pinned agent CLI, shipped in this image)
ENV CURSOR_AGENT_HOME="/opt/cursor-agent"

# Network proxy engine (downloaded / uploaded at runtime — not baked into the image)
ENV NETWORK_PROXY_DATA_DIR="" \
    NETWORK_PROXY_ENGINE_BIN="" \
    NETWORK_PROXY_ENGINE_DOWNLOAD_BASE=""

# Database
ENV KEY_VAULTS_SECRET="" \
    DATABASE_DRIVER="node" \
    DATABASE_URL=""

# Better Auth
ENV AUTH_SECRET="" \
    AUTH_SSO_PROVIDERS="" \
    AUTH_ALLOWED_EMAILS="" \
    AUTH_TRUSTED_ORIGINS="" \
    AUTH_DISABLE_EMAIL_PASSWORD="" \
    AUTH_EMAIL_VERIFICATION="" \
    AUTH_ENABLE_MAGIC_LINK="" \
    # Google
    AUTH_GOOGLE_ID="" \
    AUTH_GOOGLE_SECRET="" \
    # GitHub
    AUTH_GITHUB_ID="" \
    AUTH_GITHUB_SECRET="" \
    # Microsoft
    AUTH_MICROSOFT_ID="" \
    AUTH_MICROSOFT_SECRET="" \
    AUTH_MICROSOFT_AUTHORITY_URL="" \
    AUTH_MICROSOFT_TENANT_ID=""

# Redis
ENV REDIS_URL="" \
    REDIS_PREFIX="" \
    REDIS_TLS=""

# Email
ENV EMAIL_SERVICE_PROVIDER="" \
    SMTP_HOST="" \
    SMTP_PORT="" \
    SMTP_SECURE="" \
    SMTP_USER="" \
    SMTP_PASS="" \
    SMTP_FROM="" \
    RESEND_API_KEY="" \
    RESEND_FROM=""

# S3
ENV NEXT_PUBLIC_S3_DOMAIN="" \
    S3_PUBLIC_DOMAIN="" \
    S3_ACCESS_KEY_ID="" \
    S3_BUCKET="" \
    S3_ENDPOINT="" \
    S3_SECRET_ACCESS_KEY="" \
    S3_ENABLE_PATH_STYLE="" \
    S3_SET_ACL=""

# Cloud Sandbox
ENV SANDBOX_PROVIDER="" \
    ONLYBOXES_BASE_URL="" \
    ONLYBOXES_JIT_ISSUER="" \
    ONLYBOXES_JIT_SIGNING_KEY="" \
    ONLYBOXES_JIT_TTL_SEC="" \
    ONLYBOXES_LEASE_TTL_SEC=""

# Model Variables
ENV \
    # AI21
    AI21_API_KEY="" AI21_MODEL_LIST="" \
    # Ai360
    AI360_API_KEY="" AI360_MODEL_LIST="" \
    # AiHubMix
    AIHUBMIX_API_KEY="" AIHUBMIX_MODEL_LIST="" AIHUBMIX_PROXY_URL="" \
    # Anthropic
    ANTHROPIC_API_KEY="" ANTHROPIC_CLIENT_TIMEOUT="" ANTHROPIC_MODEL_LIST="" ANTHROPIC_PROXY_URL="" \
    # Amazon Bedrock
    ENABLED_AWS_BEDROCK="" AWS_ACCESS_KEY_ID="" AWS_SECRET_ACCESS_KEY="" AWS_REGION="" AWS_BEDROCK_MODEL_LIST="" \
    # Azure OpenAI
    AZURE_API_KEY="" AZURE_API_VERSION="" AZURE_ENDPOINT="" AZURE_MODEL_LIST="" \
    # Baichuan
    BAICHUAN_API_KEY="" BAICHUAN_MODEL_LIST="" \
    # Cloudflare
    CLOUDFLARE_API_KEY="" CLOUDFLARE_BASE_URL_OR_ACCOUNT_ID="" CLOUDFLARE_MODEL_LIST="" \
    # Cohere
    COHERE_API_KEY="" COHERE_MODEL_LIST="" COHERE_PROXY_URL="" \
    # ComfyUI
    ENABLED_COMFYUI="" COMFYUI_BASE_URL="" COMFYUI_AUTH_TYPE="" \
    COMFYUI_API_KEY="" COMFYUI_USERNAME="" COMFYUI_PASSWORD="" COMFYUI_CUSTOM_HEADERS="" \
    # DeepSeek
    DEEPSEEK_API_KEY="" DEEPSEEK_MODEL_LIST="" \
    # Fireworks AI
    FIREWORKSAI_API_KEY="" FIREWORKSAI_MODEL_LIST="" \
    # Gitee AI
    GITEE_AI_API_KEY="" GITEE_AI_MODEL_LIST="" \
    # GitHub
    GITHUB_TOKEN="" GITHUB_MODEL_LIST="" \
    # Google
    GOOGLE_API_KEY="" GOOGLE_MODEL_LIST="" GOOGLE_PROXY_URL="" \
    # Vertex AI
    VERTEXAI_CREDENTIALS="" VERTEXAI_PROJECT="" VERTEXAI_LOCATION="" VERTEXAI_MODEL_LIST="" \
    # Groq
    GROQ_API_KEY="" GROQ_MODEL_LIST="" GROQ_PROXY_URL="" \
    # Higress
    HIGRESS_API_KEY="" HIGRESS_MODEL_LIST="" HIGRESS_PROXY_URL="" \
    # HuggingFace
    HUGGINGFACE_API_KEY="" HUGGINGFACE_MODEL_LIST="" HUGGINGFACE_PROXY_URL="" \
    # Hunyuan
    HUNYUAN_API_KEY="" HUNYUAN_MODEL_LIST="" \
    # InternLM
    INTERNLM_API_KEY="" INTERNLM_MODEL_LIST="" \
    # Jina
    JINA_API_KEY="" JINA_MODEL_LIST="" JINA_PROXY_URL="" \
    # Minimax
    MINIMAX_API_KEY="" MINIMAX_MODEL_LIST="" \
    # Mistral
    MISTRAL_API_KEY="" MISTRAL_MODEL_LIST="" \
    # ModelScope
    MODELSCOPE_API_KEY="" MODELSCOPE_MODEL_LIST="" MODELSCOPE_PROXY_URL="" \
    # Moonshot
    MOONSHOT_API_KEY="" MOONSHOT_MODEL_LIST="" MOONSHOT_PROXY_URL="" \
    # Nebius
    NEBIUS_API_KEY="" NEBIUS_MODEL_LIST="" NEBIUS_PROXY_URL="" \
    # NewAPI
    NEWAPI_API_KEY="" NEWAPI_PROXY_URL="" \
    # Novita
    NOVITA_API_KEY="" NOVITA_MODEL_LIST="" \
    # Nvidia NIM
    NVIDIA_API_KEY="" NVIDIA_MODEL_LIST="" NVIDIA_PROXY_URL="" \
    # Ollama
    ENABLED_OLLAMA="" OLLAMA_MODEL_LIST="" OLLAMA_PROXY_URL="" \
    # OpenAI
    ENABLED_OPENAI="" OPENAI_API_KEY="" OPENAI_MODEL_LIST="" OPENAI_PROXY_URL="" \
    # OpenRouter
    OPENROUTER_API_KEY="" OPENROUTER_MODEL_LIST="" \
    # Perplexity
    PERPLEXITY_API_KEY="" PERPLEXITY_MODEL_LIST="" PERPLEXITY_PROXY_URL="" \
    # PPIO
    PPIO_API_KEY="" PPIO_MODEL_LIST="" \
    # Qiniu
    QINIU_API_KEY="" QINIU_MODEL_LIST="" QINIU_PROXY_URL="" \
    # Qwen
    QWEN_API_KEY="" QWEN_MODEL_LIST="" QWEN_PROXY_URL="" \
    # SambaNova
    SAMBANOVA_API_KEY="" SAMBANOVA_MODEL_LIST="" \
    # Search1API
    SEARCH1API_API_KEY="" SEARCH1API_MODEL_LIST="" \
    # SenseNova
    SENSENOVA_API_KEY="" SENSENOVA_MODEL_LIST="" \
    # SiliconCloud
    SILICONCLOUD_API_KEY="" SILICONCLOUD_MODEL_LIST="" SILICONCLOUD_PROXY_URL="" \
    # Spark
    SPARK_API_KEY="" SPARK_MODEL_LIST="" SPARK_PROXY_URL="" SPARK_SEARCH_MODE="" \
    # Stepfun
    STEPFUN_API_KEY="" STEPFUN_MODEL_LIST="" \
    # Taichu
    TAICHU_API_KEY="" TAICHU_MODEL_LIST="" \
    # TogetherAI
    TOGETHERAI_API_KEY="" TOGETHERAI_MODEL_LIST="" \
    # Upstage
    UPSTAGE_API_KEY="" UPSTAGE_MODEL_LIST="" \
    # v0 (Vercel)
    V0_API_KEY="" V0_MODEL_LIST="" \
    # vLLM
    VLLM_API_KEY="" VLLM_MODEL_LIST="" VLLM_PROXY_URL="" \
    # Wenxin
    WENXIN_API_KEY="" WENXIN_MODEL_LIST="" \
    # xAI
    XAI_API_KEY="" XAI_MODEL_LIST="" XAI_PROXY_URL="" \
    # Xinference
    XINFERENCE_API_KEY="" XINFERENCE_MODEL_LIST="" XINFERENCE_PROXY_URL="" \
    # 01.AI
    ZEROONE_API_KEY="" ZEROONE_MODEL_LIST="" \
    # Zhipu
    ZHIPU_API_KEY="" ZHIPU_MODEL_LIST="" \
    # Tencent Cloud
    TENCENT_CLOUD_API_KEY="" TENCENT_CLOUD_MODEL_LIST="" \
    # Infini-AI
    INFINIAI_API_KEY="" INFINIAI_MODEL_LIST="" \
    # 302.AI
    AI302_API_KEY="" AI302_MODEL_LIST="" \
    # FAL
    ENABLED_FAL="" FAL_API_KEY="" FAL_MODEL_LIST="" \
    # BFL
    BFL_API_KEY="" BFL_MODEL_LIST="" \
    # Vercel AI Gateway
    VERCELAIGATEWAY_API_KEY="" VERCELAIGATEWAY_MODEL_LIST="" \
    # Cerebras
    CEREBRAS_API_KEY="" CEREBRAS_MODEL_LIST=""

USER nextjs

EXPOSE 3210/tcp

ENTRYPOINT ["/bin/node"]

CMD ["/app/startServer.js"]
