import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { expandIncludes, parseTemplate, PromptLibrary, substitute } from "../src/prompts/template.ts";

describe("substitute", () => {
  test("replaces declared variables", () => {
    expect(substitute("Hi {{name}}!", ["name"], { name: "PM" }, "t")).toBe("Hi PM!");
  });

  test("single pass: injected values are never rescanned", () => {
    expect(substitute("{{doc}}", ["doc"], { doc: "price is {{price}}" }, "t")).toBe("price is {{price}}");
  });

  test("rejects used-but-undeclared, declared-but-unused, missing and extra variables", () => {
    expect(() => substitute("{{a}}", [], { a: "1" }, "t")).toThrow(/used but not declared/);
    expect(() => substitute("x", ["a"], { a: "1" }, "t")).toThrow(/declared but never used/);
    expect(() => substitute("{{a}}", ["a"], {}, "t")).toThrow(/has no value/);
    expect(() => substitute("{{a}}", ["a"], { a: "1", b: "2" }, "t")).toThrow(/provided but is not declared/);
  });
});

describe("parseTemplate", () => {
  test("reads variables from front-matter", () => {
    expect(parseTemplate("---\nvariables: [a, b]\n---\nbody", "t")).toEqual({ body: "body", declared: ["a", "b"] });
  });

  test("no front-matter means no variables", () => {
    expect(parseTemplate("just text", "t")).toEqual({ body: "just text", declared: [] });
  });
});

describe("expandIncludes", () => {
  test("pastes partials, recursively", () => {
    const files: Record<string, string> = { a: "A {{> b}}", b: "B" };
    expect(expandIncludes("[{{> a}}]", (n) => files[n] as string, ["root"])).toBe("[A B]");
  });

  test("detects cycles", () => {
    const files: Record<string, string> = { a: "{{> b}}", b: "{{> a}}" };
    expect(() => expandIncludes("{{> a}}", (n) => files[n] as string, ["root"])).toThrow(/Circular include/);
  });
});

describe("PromptLibrary", () => {
  test("override directory wins, bundled templates fill the gaps, hashes are recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "xplan-prompts-"));
    mkdirSync(join(dir, "shared"), { recursive: true });
    writeFileSync(join(dir, "shared", "nudge-submit.md"), "---\nvariables: [toolName]\n---\nCALL {{toolName}}\n");
    const lib = new PromptLibrary(dir);
    expect(lib.render("shared/nudge-submit", { toolName: "x" }).trim()).toBe("CALL x");
    expect(lib.read("shared/evidence-rules")).toContain("Evidence rules");
    expect(Object.keys(lib.hashes())).toEqual(["shared/evidence-rules", "shared/nudge-submit"]);
  });
});
