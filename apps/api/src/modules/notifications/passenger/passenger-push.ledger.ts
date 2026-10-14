import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from '../../../config/env.service';

export const PASSENGER_PUSH_LEDGER_MAX_ENTRIES = 5_000;
export const PASSENGER_PUSH_LEDGER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface TripEntry {
  readonly createdAt: number;
  sent: number;
  driverCancelled: boolean;
  tail: Promise<void>;
}

@Injectable()
export class PassengerPushLedger {
  private readonly logger = new Logger(PassengerPushLedger.name);
  private readonly entries = new Map<number, TripEntry>();

  constructor(private readonly env: EnvService) {}

  hadDriverCancellation(tripRequestId: number): boolean {
    return this.find(tripRequestId)?.driverCancelled ?? false;
  }

  recordDriverCancellation(tripRequestId: number): void {
    this.entryFor(tripRequestId).driverCancelled = true;
  }

  submit(tripRequestId: number, run: () => Promise<void>): Promise<void> | null {
    const entry = this.entryFor(tripRequestId);
    if (entry.sent >= this.env.get('PASSENGER_PUSH_MAX_PER_TRIP')) return null;
    entry.sent += 1;
    const done = entry.tail.then(run);
    entry.tail = done.catch(() => undefined);
    return done;
  }

  forget(tripRequestId: number): void {
    this.entries.delete(tripRequestId);
  }

  private find(tripRequestId: number): TripEntry | undefined {
    const entry = this.entries.get(tripRequestId);
    if (!entry) return undefined;
    if (this.isExpired(entry, Date.now())) {
      this.entries.delete(tripRequestId);
      return undefined;
    }
    return entry;
  }

  private entryFor(tripRequestId: number): TripEntry {
    const existing = this.find(tripRequestId);
    if (existing) return existing;
    this.makeRoom();
    const created: TripEntry = {
      createdAt: Date.now(),
      sent: 0,
      driverCancelled: false,
      tail: Promise.resolve(),
    };
    this.entries.set(tripRequestId, created);
    return created;
  }

  private makeRoom(): void {
    const now = Date.now();
    for (const [tripRequestId, entry] of this.entries) {
      if (!this.isExpired(entry, now)) break;
      this.entries.delete(tripRequestId);
    }
    while (this.entries.size >= PASSENGER_PUSH_LEDGER_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
      this.logger.warn(`[push:passenger] evicted tripRequest=${oldest.value}`);
    }
  }

  private isExpired(entry: TripEntry, now: number): boolean {
    return now - entry.createdAt > PASSENGER_PUSH_LEDGER_MAX_AGE_MS;
  }
}
