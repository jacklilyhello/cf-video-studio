FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# Intentionally fail instead of silently moving to another FFmpeg release.
ARG FFMPEG_VERSION=7:5.1.9-0+deb12u1
RUN apt-get update \
    && apt-get install -y --no-install-recommends "ffmpeg=${FFMPEG_VERSION}" \
    && mkdir -p /opt/licenses /work \
    && dpkg-query -W -f='${Package}\t${Version}\n' > /opt/licenses/packages.tsv \
    && ffmpeg -version > /opt/licenses/ffmpeg-version.txt \
    && ffmpeg -buildconf > /opt/licenses/ffmpeg-buildconf.txt 2>&1 \
    && cp /usr/share/doc/ffmpeg/copyright /opt/licenses/ffmpeg-copyright \
    && cp /usr/share/common-licenses/GPL-2 /usr/share/common-licenses/GPL-3 /usr/share/common-licenses/LGPL-2.1 /opt/licenses/ \
    && chown node:node /work \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node container/processor.mjs /app/processor.mjs
COPY --chown=node:node container/LICENSES.md /opt/licenses/README.md
COPY --chown=node:node LICENSE /opt/licenses/project-LICENSE
USER node
EXPOSE 8080
ENTRYPOINT ["node", "/app/processor.mjs"]
