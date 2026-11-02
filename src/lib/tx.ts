import { db } from '../db.js';

/**
 * node:sqlite 没有事务包装器，手写一个。
 * 所有"多表同时改"的操作都必须走这里 —— 否则信誉和账本会不一致。
 */
export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback 失败说明事务已经不在了 */
    }
    throw err;
  }
}
