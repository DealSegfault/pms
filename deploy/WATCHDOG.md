# PMS Watchdog Manual

The watchdog is a separate `systemd` service that supervises PM2 from outside PM2.

It exists to recover the stack when:

- `pms-backend` is `stopped`, `errored`, or missing in PM2
- `pms-engine` is `stopped`, `errored`, or missing in PM2
- the backend stays above the configured memory threshold for multiple checks
- PM2 itself stops responding to `pm2 jlist`
- recent PM2 error logs show fatal crash signatures such as out-of-memory

## Files

- Service template: `deploy/pms-watchdog.service`
- Installer: `deploy/install-watchdog-service.sh`
- Runtime script: `scripts/pm2-watchdog.mjs`

## Install

From the VPS, inside the project:

```bash
sudo bash deploy/install-watchdog-service.sh
```

`deploy/vps-setup.sh` also installs the watchdog automatically.

## Verify

```bash
systemctl status pms-watchdog
journalctl -u pms-watchdog -f
pm2 list
```

Expected behavior:

- `pms-watchdog` is `active (running)`
- journal shows `Starting watchdog`
- if `pms-backend` is stopped manually, the watchdog restarts it on the next poll

## Default behavior

The default unit configuration is:

- poll every `10s`
- restart cooldown `30s`
- backend health failures before restart: `3`
- backend memory threshold: `320MB`
- backend memory strikes before restart: `2`
- engine memory threshold disabled by default

The watchdog uses `http://127.0.0.1:3900/api/health` for backend health and PM2 JSON state for process supervision.

## Tune thresholds

Edit the environment lines in `deploy/pms-watchdog.service`, then reload:

```bash
sudo systemctl daemon-reload
sudo systemctl restart pms-watchdog
```

Useful settings:

- `WATCHDOG_POLL_MS`
- `WATCHDOG_RESTART_COOLDOWN_MS`
- `WATCHDOG_HEALTH_FAILURES`
- `WATCHDOG_MEMORY_STRIKES`
- `WATCHDOG_BACKEND_MEMORY_MB`
- `WATCHDOG_ENGINE_MEMORY_MB`
- `PM2_SYSTEMD_UNIT`

## Manual recovery

Restart only the watchdog:

```bash
sudo systemctl restart pms-watchdog
```

Watch its decisions live:

```bash
sudo journalctl -u pms-watchdog -f
```

Restart PM2 stack manually if needed:

```bash
pm2 restart pms-backend --update-env
pm2 restart pms-engine --update-env
pm2 save
```

## Notes

- This service is intentionally outside PM2 so it still works when PM2 apps crash.
- It is not a replacement for fixing memory leaks or unbounded requests; it is a recovery layer.
- The current backend health route may still report `pythonEngine:false`; the watchdog does not use that field as a restart condition.
