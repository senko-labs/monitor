'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Prevents two recorders from fighting over the same output folder, which
 * would otherwise happen when the logon task and a manual `npm start` overlap.
 */
function acquire(root) {
  const lockFile = path.join(root, 'logs', 'recorder.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });

  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      return { ok: false, pid };
    }
    fs.unlinkSync(lockFile); // stale lock from a crashed run
  }

  fs.writeFileSync(lockFile, String(process.pid));
  const release = () => {
    try {
      if (fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid)) {
        fs.unlinkSync(lockFile);
      }
    } catch { /* already removed */ }
  };
  return { ok: true, release };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

module.exports = { acquire };
