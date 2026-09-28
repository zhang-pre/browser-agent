/* Serialized credential mutations; the host owns encryption and persistence. */
export class CredentialStore {
  constructor(backend) {
    this.backend = backend;
    this.pending = new Map();
  }

  async read(id) {
    await this.pending.get(id);
    return this.backend.read(id);
  }

  modify(id, change) {
    const previous = this.pending.get(id) || Promise.resolve();
    const operation = previous.then(async () => {
      const current = await this.backend.read(id);
      const next = await change(current);
      if (next === null) await this.backend.delete(id);
      else if (next !== undefined) await this.backend.write(id, next);
      return next === undefined ? current : next;
    });
    const settled = operation.then(() => {}, () => {});
    this.pending.set(id, settled);
    settled.then(() => {
      if (this.pending.get(id) === settled) this.pending.delete(id);
    });
    return operation;
  }

  delete(id) {
    return this.modify(id, () => null);
  }
}
