import { describe, expect, it } from "vitest";
import { extractSymbols, languageOf, symbolAt } from "../src/git/symbols";

const names = (path: string, text: string) => extractSymbols(path, text).map((s) => s.name);

describe("symbols across languages", () => {
	it("knows languages by extension", () => {
		expect(languageOf("a/b.go")).toBe("go");
		expect(languageOf("lib.rs")).toBe("rust");
		expect(languageOf("App.kt")).toBe("java");
		expect(languageOf("main.cpp")).toBe("c");
		expect(languageOf("model.rb")).toBe("ruby");
		expect(languageOf("README.md")).toBe("other");
	});

	it("JavaScript re-exports and test suites", () => {
		const index = "export { default as add } from './add.js';\nexport { default as adjust } from './adjust.js';\nexport * as internal from './internal/index.js';\n";
		expect(names("source/index.js", index)).toEqual(["add", "adjust", "internal"]);
		const test = "var R = require('../source/index.js');\n\ndescribe('range', function() {\n  it('works', function() {\n    eq(R.range(0, 3), [0, 1, 2]);\n  });\n});\n\ndescribe('range #2 properties', () => {\n  it('x', () => {});\n});\n";
		const syms = extractSymbols("test/range.js", test);
		expect(syms.map((s) => s.name)).toEqual(["R", "range", "range 2 properties"]);
		expect(symbolAt(syms, 5)).toBe("range");
		expect(syms[1]).toMatchObject({ kind: "suite", start: 3, end: 7 });
	});

	it("Go functions, methods and types", () => {
		const src = `package cart

type Cart struct {
	items []Item
}

func New() *Cart {
	return &Cart{}
}

func (c *Cart) Add(item Item) error {
	if item.Qty <= 0 {
		return errors.New("qty")
	}
	c.items = append(c.items, item)
	return nil
}

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }
`;
		expect(names("cart.go", src)).toEqual(["Cart", "New", "Cart.Add", "Stack.Push"]);
		expect(symbolAt(extractSymbols("cart.go", src), 13)).toBe("Cart.Add");
	});

	it("Rust functions, impl blocks and lifetimes", () => {
		const src = `pub struct Cart<'a> {
    items: Vec<&'a Item>,
}

impl<'a> Cart<'a> {
    pub fn new() -> Self {
        Cart { items: vec![] }
    }

    pub(crate) async fn add(&mut self, item: &'a Item) {
        if item.qty == 0 { return; }
        self.items.push(item);
    }
}

impl fmt::Display for Cart<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", '}')
    }
}

pub fn total(c: &Cart) -> u32 {
    c.items.iter().map(|i| i.price).sum()
}
`;
		expect(names("cart.rs", src)).toEqual(["Cart", "Cart", "Cart.new", "Cart.add", "Cart", "Cart.fmt", "total"]);
		expect(symbolAt(extractSymbols("cart.rs", src), 23)).toBe("total");
	});

	it("Java, Kotlin and C# classes and methods", () => {
		const java = `package shop;

public class Cart {
    private final List<Item> items = new ArrayList<>();

    public Cart() {
    }

    @Override
    public synchronized int add(Item item) throws Exception {
        if (item.qty() <= 0) {
            throw new IllegalArgumentException("qty");
        }
        return items.size();
    }

    static <T> List<T> copy(List<T> xs) { return new ArrayList<>(xs); }
}
`;
		expect(names("Cart.java", java)).toEqual(["Cart", "Cart.Cart", "Cart.add", "Cart.copy"]);
		const kotlin = "class Cart {\n    fun add(item: Item) {\n        items += item\n    }\n}\n\nfun String.slugify(): String {\n    return lowercase()\n}\n";
		expect(names("Cart.kt", kotlin)).toEqual(["Cart", "Cart.add", "slugify"]);
		const cs = "public sealed class Cart\n{\n    public async Task<int> AddAsync(Item item)\n    {\n        return 1;\n    }\n}\n";
		expect(names("Cart.cs", cs)).toEqual(["Cart", "Cart.AddAsync"]);
	});

	it("C and C++ definitions, not prototypes", () => {
		const c = `#include <stdio.h>

int parse(const char *s);

static int parse(const char *s)
{
    if (s[0] == '{') {
        return 1;
    }
    return 0;
}

struct point {
    int x, y;
};

void Cart::add(int x) {
    items.push_back(x);
}
`;
		expect(names("parse.c", c)).toEqual(["parse", "point", "Cart.add"]);
	});

	it("Ruby classes and methods", () => {
		const rb = `class Cart
  def initialize
    @items = []
  end

  def add(item)
    raise ArgumentError if item.qty <= 0
    @items << item
  end

  def empty?
    @items.empty?
  end
end

def total(cart)
  cart.items.sum(&:price)
end
`;
		const syms = extractSymbols("cart.rb", rb);
		expect(syms.map((s) => s.name)).toEqual(["Cart", "Cart.initialize", "Cart.add", "Cart.empty?", "total"]);
		expect(syms[0]).toMatchObject({ start: 1, end: 14 });
		expect(symbolAt(syms, 8)).toBe("Cart.add");
	});
});
