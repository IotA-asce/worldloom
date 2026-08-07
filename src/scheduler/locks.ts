/**
 * Region reservations (ADR-0005).
 *
 * Before mutating the world an agent must hold a reservation on the axis-aligned
 * region it is about to touch, and an overlapping request is refused. The refusal
 * is the point: `REGION_RESERVED` is a first-class planning outcome the planner
 * negotiates around, which is the friction that produces coordination rather
 * than eliminating it.
 *
 * Two properties this module exists to guarantee, both of which were awkward to
 * hold while the logic lived as inline SQL inside one action executor:
 *
 *  - **Overlap has exactly one definition.** Every conflict is decided by
 *    `regionsOverlap`, the same function the rest of the core reasons about, so
 *    a hand-written bounds comparison in SQL cannot quietly drift from it.
 *  - **Reservations expire, and expiry is swept.** An agent that dies holding a
 *    build site must not deadlock that ground for the rest of the run, so every
 *    claim carries an expiry and every claim sweeps expired rows on its way past.
 */

import type { AgentId, IdFactory, ReservationId } from '../core/ids.ts';
import { fail, ok, type Result } from '../core/result.ts';
import { formatRegion, regionsOverlap, type Region } from '../core/world.ts';
import { numberCol, textCol, type Database, type Row } from '../persistence/db.ts';

export interface Reservation {
  readonly id: ReservationId;
  readonly agentId: AgentId;
  readonly region: Region;
  /** Why the ground is held, e.g. `build_structure:goal_000012`. */
  readonly purpose: string;
  readonly createdAtTicks: number;
  readonly expiresAtTicks: number;
}

/**
 * How long a claim lives without being renewed, in world ticks — half a day.
 *
 * Long enough that a builder interrupted by nightfall still owns its site in the
 * morning; short enough that a settler who died on the way back does not hold
 * the best flat ground in the valley for the rest of the run.
 */
export const DEFAULT_RESERVATION_TICKS = 12_000;

/**
 * What the service needs from the store. Narrower than `Store` on purpose: locks
 * are about one table, and a narrow dependency keeps them testable in isolation.
 */
export interface ReservationHome {
  readonly db: Database;
  readonly ids: IdFactory;
}

export interface ClaimRequest {
  readonly agentId: AgentId;
  readonly region: Region;
  /** Current world time. Expiry is measured in world ticks, never wall clock. */
  readonly atTicks: number;
  readonly purpose?: string;
  readonly durationTicks?: number;
}

function toReservation(row: Row): Reservation {
  return {
    id: textCol(row, 'id') as ReservationId,
    agentId: textCol(row, 'agent_id') as AgentId,
    region: {
      min: { x: numberCol(row, 'min_x'), y: numberCol(row, 'min_y'), z: numberCol(row, 'min_z') },
      max: { x: numberCol(row, 'max_x'), y: numberCol(row, 'max_y'), z: numberCol(row, 'max_z') },
    },
    purpose: textCol(row, 'purpose'),
    createdAtTicks: numberCol(row, 'created_at_ticks'),
    expiresAtTicks: numberCol(row, 'expires_at_ticks'),
  };
}

export class ReservationService {
  constructor(private readonly home: ReservationHome) {}

  /**
   * Claim a region.
   *
   * Fails with `REGION_RESERVED` when someone else holds overlapping ground. An
   * agent re-claiming ground it already holds renews its own claim instead of
   * inserting a second row — a retried plan step must not accumulate
   * reservations it will then only partially release.
   */
  claim(request: ClaimRequest): Result<Reservation> {
    const { agentId, region, atTicks } = request;
    const duration = Math.max(1, Math.floor(request.durationTicks ?? DEFAULT_RESERVATION_TICKS));

    return this.home.db.transaction(() => {
      // Sweep first: an expired claim is not a conflict, and leaving the rows
      // behind would slowly turn every conflict check into a full-table scan.
      this.releaseExpired(atTicks);

      const conflict = this.holderOf(region, atTicks, agentId);
      if (conflict !== null) {
        return fail<Reservation>(
          'REGION_RESERVED',
          `${conflict.agentId} is already working there`,
          { observed: { region: conflict.region, heldBy: conflict.agentId }, retryable: false },
        );
      }

      const own = this.heldBy(agentId, atTicks).find((held) => regionsOverlap(held.region, region));
      if (own !== undefined) {
        const renewed: Reservation = { ...own, expiresAtTicks: atTicks + duration };
        this.home.db
          .prepare('UPDATE reservations SET expires_at_ticks = ? WHERE id = ?')
          .run(renewed.expiresAtTicks, renewed.id);
        return ok(renewed);
      }

      const reservation: Reservation = {
        id: this.home.ids.next('resv'),
        agentId,
        region,
        purpose: request.purpose ?? '',
        createdAtTicks: atTicks,
        expiresAtTicks: atTicks + duration,
      };

      this.home.db
        .prepare(
          `INSERT INTO reservations (id, agent_id, min_x, min_y, min_z, max_x, max_y, max_z,
                                     purpose, created_at_ticks, expires_at_ticks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reservation.id,
          reservation.agentId,
          Math.floor(region.min.x),
          Math.floor(region.min.y),
          Math.floor(region.min.z),
          Math.ceil(region.max.x),
          Math.ceil(region.max.y),
          Math.ceil(region.max.z),
          reservation.purpose,
          reservation.createdAtTicks,
          reservation.expiresAtTicks,
        );

      return ok(reservation);
    });
  }

  /**
   * Who holds ground overlapping `region`, ignoring `exceptAgentId` and anything
   * already expired. Null when the ground is free.
   *
   * Public because "ask the holder" is one of the three legitimate responses to
   * a refused claim (ADR-0005), and asking requires knowing who to ask. A
   * reservation is public information — it is a visible claim on shared ground,
   * not a private belief.
   */
  holderOf(region: Region, atTicks: number, exceptAgentId?: AgentId): Reservation | null {
    for (const candidate of this.active(atTicks)) {
      if (candidate.agentId === exceptAgentId) continue;
      if (regionsOverlap(candidate.region, region)) return candidate;
    }
    return null;
  }

  /** Everything an agent currently holds. */
  heldBy(agentId: AgentId, atTicks: number): Reservation[] {
    return this.home.db
      .prepare(
        `SELECT * FROM reservations WHERE agent_id = ? AND expires_at_ticks > ?
          ORDER BY created_at_ticks ASC`,
      )
      .all(agentId, atTicks)
      .map(toReservation);
  }

  /**
   * Every unexpired reservation.
   *
   * Overlap is decided in TypeScript rather than in the WHERE clause so that
   * `regionsOverlap` stays the only definition of conflict. At V0 scale — a
   * handful of agents holding a site each — reading the live rows costs nothing
   * worth optimising against that clarity.
   */
  active(atTicks: number): Reservation[] {
    return this.home.db
      .prepare('SELECT * FROM reservations WHERE expires_at_ticks > ? ORDER BY created_at_ticks ASC')
      .all(atTicks)
      .map(toReservation);
  }

  /** Release the agent's claims overlapping `region`. Returns how many went. */
  release(agentId: AgentId, region: Region, atTicks: number): number {
    return this.home.db.transaction(() => {
      const overlapping = this.heldBy(agentId, atTicks).filter((held) =>
        regionsOverlap(held.region, region),
      );
      const statement = this.home.db.prepare('DELETE FROM reservations WHERE id = ?');
      let released = 0;
      for (const held of overlapping) {
        released += Number(statement.run(held.id).changes);
      }
      return released;
    });
  }

  /** Release everything the agent holds — what a finished or abandoned build does. */
  releaseAll(agentId: AgentId): number {
    const result = this.home.db
      .prepare('DELETE FROM reservations WHERE agent_id = ?')
      .run(agentId);
    return Number(result.changes);
  }

  /**
   * Drop claims whose expiry has passed.
   *
   * This is the mechanism that makes a dead agent harmless: nothing needs to
   * notice that it died, because its hold on the ground simply runs out.
   */
  releaseExpired(atTicks: number): number {
    const result = this.home.db
      .prepare('DELETE FROM reservations WHERE expires_at_ticks <= ?')
      .run(atTicks);
    return Number(result.changes);
  }

  /** Does this agent hold ground covering `region`? Used before a mutation. */
  holds(agentId: AgentId, region: Region, atTicks: number): boolean {
    return this.heldBy(agentId, atTicks).some((held) => regionsOverlap(held.region, region));
  }
}

/** For logs and plan-step notes. */
export function describeReservation(reservation: Reservation): string {
  const purpose = reservation.purpose === '' ? '' : ` for ${reservation.purpose}`;
  return `${reservation.agentId} holds ${formatRegion(reservation.region)}${purpose} ` +
    `until tick ${reservation.expiresAtTicks}`;
}
