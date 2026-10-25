export type EventLevel = "info" | "warning" | "error";
export type EventCategory = "auth" | "service" | "monitoring" | "system" | "hosting";

export interface AppEvent {
  id: number;
  time: string;
  level: EventLevel;
  category: EventCategory;
  message: string;
}

/**
 * In-memory ring buffer of curated application events. Messages are written
 * by our own code only — never raw log lines, request bodies, or secrets.
 */
export class EventLog {
  private items: AppEvent[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 200) {}

  add(level: EventLevel, category: EventCategory, message: string) {
    this.items.push({ id: this.nextId++, time: new Date().toISOString(), level, category, message });
    if (this.items.length > this.capacity) this.items.shift();
  }

  list(limit = 100): AppEvent[] {
    return this.items.slice(-limit).reverse();
  }
}
