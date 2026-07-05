# infra/

Infrastructure-as-code and runtime configuration for Crivacy API.

Contents map 1:1 to PLAN.md §14–§22:

| Path                         | Owner step | Purpose                                                                           |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `ansible/`                   | 17, 19, 21 | Ansible playbooks (non-destructive host bootstrap)                                |
| `docker-compose/api/`        | 21         | Backend runtime (Next.js + Postgres + pg-boss workers)                            |
| `docker-compose/monitoring/` | 17         | Prometheus + Grafana + Loki + Tempo + Alertmanager stack                          |
| `nginx/`                     | 21         | Reverse-proxy server blocks (api / dashboard / docs / status)                     |
| `systemd/`                   | 22         | `autossh-crivacy-validator.service` + related unit files                          |
| `prometheus/`                | 17         | Scrape configs, alert rules                                                       |
| `grafana/dashboards/`        | 17         | Provisioned dashboard JSON                                                        |
| `alertmanager/`              | 17         | Routing + Telegram receiver                                                       |
| `scripts/`                   | 21, 26     | Cloudflare IP sync, backup orchestration, SQLite->Postgres                        |
| `secrets/`                   | 23         | sops+age encrypted `.env` files (repo is public — only encrypted commits allowed) |

All deployment targets are **TBD** (see MEMORY.md). Every file here is written to
be host-agnostic: paths, ports, and hostnames are driven by environment variables
or `group_vars` so that the first real deploy only changes the inventory file.

## Hard rules

- **Validator host (MainNet, <MAINNET_VALIDATOR_HOST>) is pristine.** Nothing in this
  directory may push binaries, daemons, or systemd units onto that host except
  the outbound-only Alloy sidecar compose file (step 19) which explicitly lives
  in its own directory and does not touch existing splice containers.
- **DevNet host (<BACKEND_API_HOST>) is retired.** Do not target it from any new
  playbook. It is listed in `memory/api-server-inventory.md` for reference only.
- **Secrets are never committed in plaintext.** `scripts/sops-check.sh` (step 23)
  is wired into the pre-commit hook and CI.
