// Local desktop repair: activate the matching UI only when a new server process starts.
// Replacing this entry file does not interrupt an already-running Muse host.
const fs = require('node:fs');
const path = require('node:path');
const staged = path.join(__dirname, 'muse-recovery');
const frontend = path.join(__dirname, 'frontend');
fs.cpSync(path.join(staged, 'frontend'), frontend, { recursive: true });
// The desktop launcher consumes the first stdout line as its readiness handshake.
// Diagnostics belong on stderr, which the launcher retains in server.log.
process.stderr.write('Helicon Muse recovery repair activated (local session titles; read-only recovery).\n');
require(path.join(staged, 'server.cjs'));
