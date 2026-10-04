// A shopping cart holds lines of { isbn, qty }.

export class Cart {
  constructor() {
    this.lines = [];
  }

  add(isbn, qty = 1) {
    if (qty <= 0) {
      throw new Error("qty must be positive");
    }
    this.lines.push({ isbn, qty });
  }

  remove(isbn) {
    this.lines = this.lines.filter((line) => line.isbn !== isbn);
  }

  count() {
    return this.lines.reduce((sum, line) => sum + line.qty, 0);
  }
}
