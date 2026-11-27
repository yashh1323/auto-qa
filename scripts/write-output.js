import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Replace the directory entry atomically. Never follow an existing output file's links.
export function writeOutput(file, data) {
  const temporary = path.join(path.dirname(file), `.auto-qa-${randomUUID()}.tmp`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
