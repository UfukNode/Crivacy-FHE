# Base image pinned to digest so a retagged `node:22-alpine` upstream
# cannot silently land a compromised layer during a rebuild. Dependabot
# (see `.github/dependabot.yml`, `package-ecosystem: docker`) opens a
# bump PR when a newer digest ships so the pin stays current with
# review rather than rotting unpatched.
FROM node:26-alpine@sha256:725aeba2364a9b16beae49e180d83bd597dbd0b15c47f1f28875c290bfd255b9
WORKDIR /app
COPY bot.mjs .
# Default non-root user baked into the official image. Keeps the
# alert-bot from being able to modify /app or escalate beyond the
# mounted-config surface if a malicious payload ever makes it in via
# Prometheus alert JSON.
USER node
EXPOSE 9095
# Lightweight liveness probe — the bot listens on :9095 and answers
# `/health` with 200 so Docker / systemd / k8s can cycle a stuck
# instance without external monitoring. `wget --spider` is available
# in the alpine base and has no dependency on curl being installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --spider -q http://127.0.0.1:9095/health || exit 1
CMD ["node", "bot.mjs"]
