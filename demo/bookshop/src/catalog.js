// The catalog of books for sale. Prices are integer cents.

export function createCatalog(books) {
  const byIsbn = new Map();
  for (const book of books) {
    byIsbn.set(book.isbn, { ...book });
  }
  return byIsbn;
}

export function findByIsbn(catalog, isbn) {
  return catalog.get(isbn) ?? null;
}

export function search(catalog, query) {
  const results = [];
  for (const book of catalog.values()) {
    if (book.title.includes(query)) {
      results.push(book);
    }
  }
  return results;
}

export const SAMPLE_BOOKS = [
  { isbn: "9780143127550", title: "The Sympathizer", author: "Viet Thanh Nguyen", priceCents: 1800, weightGrams: 450, format: "paperback" },
  { isbn: "9780593135204", title: "Project Hail Mary", author: "Andy Weir", priceCents: 2899, weightGrams: 700, format: "hardcover" },
  { isbn: "9780374533557", title: "Thinking, Fast and Slow", author: "Daniel Kahneman", priceCents: 1999, weightGrams: 520, format: "paperback" },
  { isbn: "9780262046305", title: "Introduction to Algorithms", author: "Thomas H. Cormen", priceCents: 13500, weightGrams: 2200, format: "hardcover" },
  { isbn: "9781984801258", title: "Klara and the Sun", author: "Kazuo Ishiguro", priceCents: 1700, weightGrams: 400, format: "paperback" },
];
