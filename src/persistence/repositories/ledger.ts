/**
 * The resource ledger (ADR-0004).
 *
 * Worldloom owns inventory because logical agents have no Minecraft inventory to
 * read. The integrity rule that keeps this honest rather than decorative:
 * quantities may only be credited against *verified* world change, and a debit
 * that would go negative fails instead of clamping — an agent cannot build with
 * resources it never gathered.
 */

import type { AgentId, SettlementId } from '../../core/ids.ts';
import { fail, ok, type Result } from '../../core/result.ts';
import {
  bundleGet,
  formatBundle,
  RESOURCE_KINDS,
  type ResourceBundle,
  type ResourceKind,
} from '../../core/world.ts';
import { numberCol, textCol, type Database } from '../db.ts';

export type OwnerKind = 'agent' | 'settlement';

export interface LedgerOwner {
  readonly id: AgentId | SettlementId | string;
  readonly kind: OwnerKind;
}

export function agentOwner(id: AgentId): LedgerOwner {
  return { id, kind: 'agent' };
}

export function settlementOwner(id: SettlementId): LedgerOwner {
  return { id, kind: 'settlement' };
}

export class LedgerRepository {
  constructor(private readonly db: Database) {}

  balance(owner: LedgerOwner): ResourceBundle {
    const rows = this.db
      .prepare('SELECT resource, quantity FROM resources WHERE owner_id = ? AND owner_kind = ?')
      .all(owner.id, owner.kind);

    const bundle: ResourceBundle = {};
    for (const row of rows) {
      const quantity = numberCol(row, 'quantity');
      if (quantity !== 0) {
        bundle[textCol(row, 'resource') as ResourceKind] = quantity;
      }
    }
    return bundle;
  }

  quantity(owner: LedgerOwner, resource: ResourceKind): number {
    const row = this.db
      .prepare(
        'SELECT quantity FROM resources WHERE owner_id = ? AND owner_kind = ? AND resource = ?',
      )
      .get(owner.id, owner.kind, resource);
    return row === undefined ? 0 : numberCol(row, 'quantity');
  }

  /**
   * Add resources. Only ever called with quantities confirmed removed from the
   * world — see the harvest executor, which counts verified blocks rather than
   * requested ones.
   */
  credit(owner: LedgerOwner, bundle: ResourceBundle): void {
    const statement = this.db.prepare(
      `INSERT INTO resources (owner_id, owner_kind, resource, quantity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (owner_id, owner_kind, resource)
         DO UPDATE SET quantity = quantity + excluded.quantity`,
    );
    this.db.transaction(() => {
      for (const resource of RESOURCE_KINDS) {
        const amount = bundleGet(bundle, resource);
        if (amount > 0) statement.run(owner.id, owner.kind, resource, amount);
      }
    });
  }

  /**
   * Remove resources, all or nothing. Fails with INSUFFICIENT_RESOURCES when the
   * owner is short — the planner reads that failure and inserts an acquisition
   * step rather than the build silently proceeding.
   */
  debit(owner: LedgerOwner, bundle: ResourceBundle): Result<ResourceBundle> {
    return this.db.transaction(() => {
      const have = this.balance(owner);
      const missing: ResourceBundle = {};
      let short = false;
      for (const resource of RESOURCE_KINDS) {
        const deficit = bundleGet(bundle, resource) - bundleGet(have, resource);
        if (deficit > 0) {
          missing[resource] = deficit;
          short = true;
        }
      }
      if (short) {
        return fail<ResourceBundle>(
          'INSUFFICIENT_RESOURCES',
          `short of ${formatBundle(missing)}`,
          { observed: { have, missing }, retryable: false },
        );
      }

      const statement = this.db.prepare(
        `UPDATE resources SET quantity = quantity - ?
          WHERE owner_id = ? AND owner_kind = ? AND resource = ?`,
      );
      for (const resource of RESOURCE_KINDS) {
        const amount = bundleGet(bundle, resource);
        if (amount > 0) statement.run(amount, owner.id, owner.kind, resource);
      }
      return ok(this.balance(owner));
    });
  }

  /**
   * Move resources between owners atomically. The debit and credit must be one
   * transaction or a crash mid-transfer would create or destroy resources.
   */
  transfer(from: LedgerOwner, to: LedgerOwner, bundle: ResourceBundle): Result<void> {
    return this.db.transaction(() => {
      const debited = this.debit(from, bundle);
      if (!debited.ok) return debited as Result<never>;
      this.credit(to, bundle);
      return ok(undefined);
    });
  }

  /** Whether the owner can cover a requirement, without modifying anything. */
  canAfford(owner: LedgerOwner, bundle: ResourceBundle): boolean {
    const have = this.balance(owner);
    return RESOURCE_KINDS.every(
      (resource) => bundleGet(have, resource) >= bundleGet(bundle, resource),
    );
  }

  /** Everything in the settlement's economy, for the dashboard. */
  totals(): Map<string, ResourceBundle> {
    const rows = this.db
      .prepare('SELECT owner_id, owner_kind, resource, quantity FROM resources WHERE quantity > 0')
      .all();
    const out = new Map<string, ResourceBundle>();
    for (const row of rows) {
      const key = `${textCol(row, 'owner_kind')}:${textCol(row, 'owner_id')}`;
      const bundle = out.get(key) ?? {};
      bundle[textCol(row, 'resource') as ResourceKind] = numberCol(row, 'quantity');
      out.set(key, bundle);
    }
    return out;
  }
}
