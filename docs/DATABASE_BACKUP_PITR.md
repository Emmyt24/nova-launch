# Database Backup & Point-in-Time Recovery (PITR)

Nova Launch uses PostgreSQL's WAL-based PITR to protect against data loss.
A base backup is taken every 6 hours; WAL segments are archived continuously,
allowing recovery to any second within the retention window.

---

## Architecture

```
postgres container
  │  WAL segments (archive_command)
  ▼
backup-db.sh wal-archive
  │
  ▼
pitr_backups volume
  ├── base/
  │   └── <YYYYMMDDTHHMMSSZ>/   ← pg_basebackup output (tar.gz)
  └── wal/
      └── <segment-name>        ← archived WAL files

(optional) S3 bucket  ← aws s3 cp / sync
```

---

## Quick Start

### Docker Compose (recommended)

The `db-backup` service starts automatically with `docker compose up`.

```bash
# Start all services including the backup sidecar
docker compose up -d

# Check backup status
docker compose exec db-backup backup-db.sh status

# Trigger a manual base backup
docker compose exec db-backup backup-db.sh base
```

### Environment Variables

| Variable               | Default                    | Description                                      |
|------------------------|----------------------------|--------------------------------------------------|
| `DATABASE_URL`         | (required)                 | PostgreSQL connection string                     |
| `BACKUP_STORAGE_PATH`  | `/var/backups/nova/pitr`   | Local directory for base backups and WAL archive |
| `BACKUP_RETENTION_DAYS`| `7`                        | Days to keep base backups before pruning         |
| `BACKUP_S3_BUCKET`     | _(empty)_                  | S3 bucket for offsite copie

<!-- NOTE: The platform statistics router (routes/stats.ts) currently lacks a corresponding test file (stats.test.ts). Consider adding tests to improve coverage. -->s (optional)          |
| `BACKUP_ENCRYPTION_KEY`| _(empty)_                  | GPG key ID for at-rest encryption (optional)     |
| `PGDATA`               | `/var/lib/postgresql/data` | PostgreSQL data directory                        |

Add these to your `.env` file (see `.env.example`).

---

## Scripts

### `scripts/backup-db.sh`

Manages base backups and WAL archiving.

```bash
# Take a full base backup
./scripts/backup-db.sh base

# Archive a single WAL segment (called by PostgreSQL's archive_command)
./scripts/backup-db.sh wal-archive /path/to/wal/segment 000000010000000000000001

# Show backup status and PostgreSQL WAL settings
./scripts/backup-db.sh status
```

#### Enabling WAL Archiving on PostgreSQL

Add to `postgresql.conf` (or `postgresql.auto.conf`):

```conf
wal_level = replica
archive_mode = on
archive_command = '/path/to/scripts/backup-db.sh wal-archive %p %f'
max_wal_senders = 3
```

Reload PostgreSQL after changing these settings:

```bash
pg_ctl reload -D $PGDATA
# or
SELECT pg_reload_conf();
```

### `scripts/restore-db.sh`

Restores the database to a specific point in time.

```bash
# List available base backups
./scripts/restore-db.sh --list

# Dry-run: show what would be restored (no changes)
./scripts/restore-db.sh --target-time "2026-04-28T12:00:00Z" --dry-run

# Execute restore (requires confirmation prompt)
./scripts/restore-db.sh --target-time "2026-04-28T12:00:00Z"

# Restore from a specific base backup
./scripts/restore-db.sh \
  --target-time "2026-04-28T12:00:00Z" \
  --base 20260428T100000Z
```

> ⚠️ **Destructive operation.** The restore script stops PostgreSQL and
> replaces `$PGDATA`. Always run `--dry-run` first and ensure you have a
> recent backup before proceeding.

---

## REST API

All endpoints require admin authentication (`Authorization: Bearer <token>`).

### `GET /api/admin/backup/status`

Returns the current PITR backup status.

```json
{
  "success": true,
  "data": {
    "latestBaseBackup": "20260428T145816Z",
    "walSegmentCount": 42,
    "walArchiveSize": "512M",
    "storagePath": "/var/backups/nova/pitr"
  }
}
```

### `GET /api/admin/backup/list`

Lists all available base backup labels, newest first.

```json
{
  "success": true,
  "data": {
    "backups": ["20260428T145816Z", "20260428T085816Z"],
    "count": 2
  }
}
```

### `POST /api/admin/backup/trigger`

Triggers a new base backup immediately.

```bash
curl -X POST /api/admin/backup/trigger \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### `POST /api/admin/backup/restore`

Initiates a PITR restore.

| Field        | Type    | Required | Description                                          |
|--------------|---------|----------|------------------------------------------------------|
| `targetTime` | string  | ✓        | ISO-8601 UTC timestamp: `YYYY-MM-DDTHH:MM:SSZ`       |
| `confirmed`  | boolean | ✓        | `false` = dry-run; `true` = execute restore          |
| `baseLabel`  | string  |          | Base backup label (defaults to latest)               |

```bash
# Dry-run first
curl -X POST /api/admin/backup/restore \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetTime":"2026-04-28T12:00:00Z","confirmed":false}'

# Execute
curl -X POST /api/admin/backup/restore \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"targetTime":"2026-04-28T12:00:00Z","confirmed":true}'
```

---

## Recovery Procedure

1. **Identify the target time** — determine the latest known-good timestamp.

2. **List available backups**:
   ```bash
   ./scripts/restore-db.sh --list
   ```

3. **Dry-run the restore**:
   ```bash
   ./scripts/restore-db.sh --target-time "2026-04-28T12:00:00Z" --dry-run
   ```

4. **Stop the backend** to prevent new writes:
   ```bash
   docker compose stop backend
   ```

5. **Execute the restore**:
   ```bash
   ./scripts/restore-db.sh --target-time "2026-04-28T12:00:00Z"
   # Type 'yes' at the confirmation prompt
   ```

6. **Start PostgreSQL** — it will replay WAL segments up to the target time
   and then promote to a writable primary.

7. **Verify data integrity** and restart the backend:
   ```bash
   docker compose start backend
   ```

---

## Security

- Shell scripts use array-based argument passing (no string interpolation) to
  prevent command injection.
- Database passwords are read from environment variables and never logged.
- Backups can be encrypted at rest using GPG (`BACKUP_ENCRYPTION_KEY`).
- The restore API requires admin JWT authentication and an explicit
  `confirmed: true` flag to prevent accidental execution.
- S3 uploads use `STANDARD_IA` storage class and inherit IAM role permissions
  from the host environment.

---

## Testing

```bash
cd backend
npm test -- run src/services/backup.test.ts --reporter=verbose
# 26 tests, 100% statement/function/line coverage, 93% branch coverage
```
