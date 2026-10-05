import { describe, expect, it } from "vitest";
import { conventionalTestCommand } from "../src/tower/briefing";

const repo = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe("conventionalTestCommand", () => {
	it("uses npm test when package.json defines a real test script", async () => {
		expect(await conventionalTestCommand(repo({ "package.json": JSON.stringify({ scripts: { test: "mocha" } }) }))).toBe("npm test");
	});

	it("skips npm init's placeholder and falls back to a test runner", async () => {
		const placeholder = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
		expect(await conventionalTestCommand(repo({ "package.json": placeholder, "test/run.mjs": "" }))).toBe("node test/run.mjs");
	});

	it("finds a test/run.mjs runner without package.json, and nothing in an empty repo", async () => {
		expect(await conventionalTestCommand(repo({ "test/run.mjs": "// runner" }))).toBe("node test/run.mjs");
		expect(await conventionalTestCommand(repo({ "package.json": "not json" }))).toBeNull();
		expect(await conventionalTestCommand(repo({}))).toBeNull();
	});
});
