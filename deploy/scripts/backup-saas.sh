#!/usr/bin/env bash
# 卷舍 SaaS · 每日备份租户数据卷(juanshe-saas-data)。
# 单实例 + 文件存储 = 一份卷损坏全站瘫;每日 tar 快照 + 保留 N 天是 MVP 的命根。
# 装 cron:  0 4 * * *  /opt/juanshe-saas/deploy/scripts/backup-saas.sh >> /var/log/juanshe-backup.log 2>&1
set -euo pipefail

VOLUME="${JUANSHE_SAAS_VOLUME:-juanshe-saas-data}"   # docker named volume(见 compose)
DEST="${JUANSHE_BACKUP_DIR:-/var/backups/juanshe-saas}"
KEEP_DAYS="${JUANSHE_BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST"
# 用临时容器挂卷 → tar 到宿主备份目录(不依赖 api 容器在不在跑)。
docker run --rm \
  -v "${VOLUME}:/data:ro" \
  -v "${DEST}:/backup" \
  node:22-slim \
  tar czf "/backup/saas-${STAMP}.tar.gz" -C /data .

# 滚动清理:只留最近 KEEP_DAYS 天。
find "$DEST" -name 'saas-*.tar.gz' -type f -mtime "+${KEEP_DAYS}" -delete

echo "[backup] $(date -Is) → ${DEST}/saas-${STAMP}.tar.gz ($(du -h "${DEST}/saas-${STAMP}.tar.gz" | cut -f1))"
