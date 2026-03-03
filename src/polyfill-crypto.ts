/**
 * Node 18: TypeORM uses global crypto.randomUUID(); ensure it exists.
 * Import this first in main.ts.
 */
if (typeof (globalThis as any).crypto?.randomUUID !== 'function') {
  const nodeCrypto = require('crypto');
  (globalThis as any).crypto = (globalThis as any).crypto || {};
  (globalThis as any).crypto.randomUUID =
    nodeCrypto.randomUUID?.bind(nodeCrypto) ||
    (() => nodeCrypto.randomBytes(16).toString('hex'));
}
