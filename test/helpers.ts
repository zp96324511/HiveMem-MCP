import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../src/db.js';

export interface Fixture {
  db: Db;
  dir: string;
  projDir: string;
  cleanup: () => void;
}

/** Temp database plus a temp "project directory" for marker/CWD tests. */
export function fixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivemem-'));
  const projDir = path.join(dir, 'myproj');
  mkdirSync(projDir);
  const db = openDb(path.join(dir, 'hivemem.db'));
  return {
    db,
    dir,
    projDir,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
