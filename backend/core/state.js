'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCHEMA_VERSION = 1;

function now() {
  return new Date().toISOString();
}

function emptyData() {
  return {
    schema_version: SCHEMA_VERSION,
    install_id: crypto.randomUUID(),
    status: 'idle',
    created_at: now(),
    updated_at: now(),
    steps: {},
  };
}

// Durable install state: one JSON file, atomic replace, resumable.
class InstallState {
  constructor(file, data) {
    if (!file) throw new Error('state file is required');
    this.file = file;
    this.data = Object.assign(emptyData(), data || {});
    if (!this.data.steps || typeof this.data.steps !== 'object') this.data.steps = {};
    this.data.schema_version = SCHEMA_VERSION;
  }

  static load(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('state is not an object');
      return new InstallState(file, data);
    } catch (err) {
      if (err && err.code === 'ENOENT') return new InstallState(file);
      // Corrupt state must never block a repair install: keep a copy and reset.
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch (_) {}
      return new InstallState(file);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data.updated_at = now();
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    try {
      fs.renameSync(tmp, this.file);
    } catch (_) {
      try { fs.unlinkSync(this.file); } catch (_) {}
      fs.renameSync(tmp, this.file);
    }
    return this;
  }

  beginStep(id, title) {
    this.data.status = 'running';
    this.data.steps[id] = {
      status: 'running',
      title: title || id,
      started_at: now(),
      finished_at: '',
      detail: '',
      error: null,
      rolled_back: false,
    };
    return this.save();
  }

  completeStep(id, detail) {
    const step = this.data.steps[id] || (this.data.steps[id] = { title: id });
    step.status = 'done';
    step.finished_at = now();
    step.detail = detail === undefined || detail === null ? '' : String(detail).slice(0, 2000);
    step.error = null;
    if (this._allFinished()) this.data.status = 'done';
    return this.save();
  }

  skipStep(id, reason) {
    const step = this.data.steps[id] || (this.data.steps[id] = { title: id });
    step.status = 'skipped';
    step.finished_at = now();
    step.detail = reason ? String(reason).slice(0, 2000) : '';
    if (this._allFinished()) this.data.status = 'done';
    return this.save();
  }

  failStep(id, error) {
    const step = this.data.steps[id] || (this.data.steps[id] = { title: id });
    step.status = 'failed';
    step.finished_at = now();
    step.error = error && typeof error.toJSON === 'function' ? error.toJSON() : { message: String(error || '') };
    this.data.status = 'failed';
    return this.save();
  }

  markRolledBack(id) {
    const step = this.data.steps[id];
    if (step) step.rolled_back = true;
    return this.save();
  }

  reset() {
    const id = this.data.install_id;
    const created = this.data.created_at;
    this.data = emptyData();
    this.data.install_id = id;
    this.data.created_at = created;
    return this.save();
  }

  getStep(id) {
    return this.data.steps[id] || null;
  }

  summary() {
    const steps = Object.keys(this.data.steps).map((id) => {
      const s = this.data.steps[id];
      return { id, title: s.title || id, status: s.status || 'unknown', detail: s.detail || '' };
    });
    return {
      install_id: this.data.install_id,
      status: this.data.status,
      created_at: this.data.created_at,
      updated_at: this.data.updated_at,
      steps,
    };
  }

  _allFinished() {
    const values = Object.values(this.data.steps);
    return values.length > 0 && values.every((s) => s.status === 'done' || s.status === 'skipped');
  }
}

module.exports = { InstallState, SCHEMA_VERSION };
