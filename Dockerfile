# pi-web in a clean container — everything it needs, nothing from the host.
#
#   docker build -t pi-web .                       # with chromium (browser panel works)
#   docker build -t pi-web --build-arg WITH_BROWSER=0 .   # slim, no browser
#
#   docker run --rm -p 5174:5174 \
#     -v "$HOME/.pi/agent:/root/.pi/agent" \
#     -v "$PWD:/workspace" pi-web
#
FROM node:24-slim

ARG WITH_BROWSER=1

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    CHROME_PATH=/usr/bin/chromium \
    PI_CODING_AGENT_DIR=/root/.pi/agent

# Mainland mirrors: deb.debian.org is unusably slow from here.
RUN sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git procps lsof \
    && rm -rf /var/lib/apt/lists/*

# Chromium powers the built-in browser panel (CDP). Skip with --build-arg WITH_BROWSER=0.
RUN if [ "$WITH_BROWSER" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list.d/debian.sources \
      && apt-get update && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
        chromium fonts-noto-cjk \
      && rm -rf /var/lib/apt/lists/*; \
    fi

# pi itself: pi-web is a front-end for it, nothing works without the agent.
RUN npm i -g @earendil-works/pi-coding-agent

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY index.ts ws-lite.ts ./
COPY ui ./ui
COPY bin ./bin
RUN chmod +x /app/bin/pi-web.mjs && ln -sf /app/bin/pi-web.mjs /usr/local/bin/pi-web

# Sessions, auth and the sqlite index live here; mount it to keep them.
VOLUME ["/root/.pi/agent"]
EXPOSE 5174

ENTRYPOINT ["node", "/app/bin/pi-web.mjs"]
CMD ["--host", "0.0.0.0", "--port", "5174", "--no-open"]
