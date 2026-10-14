/**
 * Small bounded "recently seen" set. whatsapp-web.js can emit the same message twice
 * (reconnects, history sync); this drops repeats before they cost an API call.
 * The API's unique (channel, externalMessageId) constraint remains the real guarantee.
 */
export class RecentIds {
  private readonly seen = new Map<string, true>();

  constructor(private readonly capacity = 1000) {}

  /** Returns true the first time an ID is seen, false for repeats. */
  add(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.set(id, true);
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
