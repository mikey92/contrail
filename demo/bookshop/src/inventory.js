// Stock levels per ISBN.

export class Inventory {
  constructor(levels = {}) {
    this.levels = new Map(Object.entries(levels));
  }

  available(isbn) {
    return this.levels.get(isbn) ?? 0;
  }

  take(isbn, qty) {
    const left = this.available(isbn) - qty;
    if (left < 0) {
      throw new Error(`only ${this.available(isbn)} left of ${isbn}`);
    }
    this.levels.set(isbn, left);
  }
}
