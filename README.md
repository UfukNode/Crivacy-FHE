# Crivacy

FHE-native re-usable KYC credential platform (Zama FHEVM on Sepolia) — B2B API.

## Layout

```
apps/web/      Next.js 15 App Router — single deployable
packages/      Workspace-local libraries (runtime-free types, shared config)
infra/         Host-agnostic infrastructure (Ansible, docker-compose, nginx, systemd)
```

## Requirements

- Node.js **22** LTS (see `.nvmrc`)
- pnpm **9.x** (see `packageManager` in `package.json`)
- PostgreSQL **16**
- Docker (for monitoring stack and cross-service integration tests)

## Quick start

```bash
pnpm install
pnpm dev         # boots apps/web on http://127.0.0.1:3001
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

## License

Proprietary — all rights reserved.
