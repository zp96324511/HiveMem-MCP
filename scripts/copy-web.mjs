// Copies web/ into dist/web so the published package ships the management UI.
import { cpSync, rmSync } from 'node:fs';

rmSync('dist/web', { force: true, recursive: true });
cpSync('web', 'dist/web', { recursive: true });
console.log('copied web/ -> dist/web/');
