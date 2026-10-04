import assert from "node:assert/strict";
import { createCatalog, findByIsbn, search, SAMPLE_BOOKS } from "../src/catalog.js";

const catalog = createCatalog(SAMPLE_BOOKS);

export function findsBooksByIsbn() {
  assert.equal(findByIsbn(catalog, "9780593135204").title, "Project Hail Mary");
  assert.equal(findByIsbn(catalog, "nope"), null);
}

export function searchesTitles() {
  const hits = search(catalog, "Sun");
  assert.deepEqual(hits.map((b) => b.title), ["Klara and the Sun"]);
}
