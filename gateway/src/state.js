import fs from 'node:fs';

// A small JSON store that survives restarts (session id, open approvals, ...).
// Written atomically (temp file + rename) and readable only by its owner.
export class State {
  constructor(file) {
    this.file = file;
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { this.data = {}; }
  }

  get(key) { return this.data[key]; }

  set(key, value) {
    if (value === undefined || value === null) delete this.data[key];
    else this.data[key] = value;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// The same interface in memory, for tests and the simulator.
export class MemoryState {
  constructor(data = {}) { this.data = { ...data }; }
  get(key) { return this.data[key]; }
  set(key, value) { if (value == null) delete this.data[key]; else this.data[key] = value; }
}
