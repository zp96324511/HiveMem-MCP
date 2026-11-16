// Environment preflight: verifies node:sqlite + FTS5 trigram + CJK LIKE support.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(c, tokenize='trigram')");
db.exec("INSERT INTO t VALUES ('我们决定选择 SQLite 因为零运维，避免重复踩坑')");
const ftsHit = db.prepare('SELECT c FROM t WHERE t MATCH ?').all('"选择 SQLite"');
const likeHit = db.prepare("SELECT c FROM t WHERE c LIKE ? ESCAPE '\\'").all('%踩坑%');
const bm25 = db.prepare('SELECT bm25(t) AS r FROM t WHERE t MATCH ?').all('"零运维"');
console.log(JSON.stringify({
  node: process.version,
  sqlite: 'ok',
  fts5Trigram: ftsHit.length === 1,
  cjkLike: likeHit.length === 1,
  bm25: bm25.length === 1,
}, null, 2));
