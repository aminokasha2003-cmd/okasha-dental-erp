import datetime
import os
import subprocess

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Write a compressed pg_dump of the database to BACKUP_DIR and delete backups older than BACKUP_KEEP_DAYS."

    def handle(self, *args, **opts):
        db = settings.DATABASES["default"]
        backup_dir = settings.BACKUP_DIR
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        target = backup_dir / f"{db['NAME']}-{stamp}.dump"
        cmd = ["pg_dump", "--format=custom", "--no-owner", "--file", str(target), "--dbname", db["NAME"]]
        if db.get("HOST"):
            cmd += ["--host", db["HOST"]]
        if db.get("PORT"):
            cmd += ["--port", str(db["PORT"])]
        if db.get("USER"):
            cmd += ["--username", db["USER"]]
        env = {**os.environ, "PGPASSWORD": db.get("PASSWORD") or ""}
        result = subprocess.run(cmd, env=env, capture_output=True, text=True)
        if result.returncode != 0:
            target.unlink(missing_ok=True)
            raise CommandError(f"pg_dump failed: {result.stderr.strip()}")
        self.stdout.write(self.style.SUCCESS(f"Backup written to {target}"))

        cutoff = datetime.datetime.now() - datetime.timedelta(days=settings.BACKUP_KEEP_DAYS)
        for old in backup_dir.glob(f"{db['NAME']}-*.dump"):
            if datetime.datetime.fromtimestamp(old.stat().st_mtime) < cutoff:
                old.unlink()
                self.stdout.write(f"Removed old backup {old.name}")
