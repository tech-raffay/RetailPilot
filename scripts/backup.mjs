import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dataDir = resolve(process.env.RETAILPILOT_DATA_DIR || '.retailpilot');
const backupDir = resolve(process.env.RETAILPILOT_BACKUP_DIR || join(dataDir, 'backups'));
const timestamp = new Date().toISOString().replaceAll(':', '-');
const destination = join(backupDir, `retail-${timestamp}-${randomUUID()}.sqlite`);
const temporary = destination + '.partial';
const source = new DatabaseSync(join(dataDir, 'retail.sqlite'), { readOnly: true });
try {
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  source.exec('PRAGMA busy_timeout = 5000');
  source.prepare('VACUUM INTO ?').run(temporary);
  const snapshot = new DatabaseSync(temporary, { readOnly: true });
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
      throw new Error('SQLite backup failed its integrity check.');
    }
    const invalid = snapshot.prepare('SELECT count(*) AS n FROM organizations WHERE NOT json_valid(document)').get();
    if (invalid.n) throw new Error('Backup contains invalid workspace documents.');
  } finally {
    snapshot.close();
  }
  await rename(temporary, destination);
  console.log('Verified SQLite backup saved to', destination);
} finally {
  source.close();
  await rm(temporary, { force: true });
}
