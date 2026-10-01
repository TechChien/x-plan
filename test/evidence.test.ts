import { describe, expect, test } from "vitest";
import { SourceIndex } from "../src/extract/evidence.ts";

const index = new SourceIndex([
  { path: "prd.md", converted: false, text: "# 退貨\n會員可於下單後 3 天內取消訂單。\n取消後應退款至原付款方式。\nSKU：庫存單位\nSKU 必須唯一" },
]);

describe("SourceIndex.verify", () => {
  test("accepts a quote inside the cited lines", () => {
    const r = index.verify({ file: "prd.md", lineStart: 2, lineEnd: 2, quote: "會員可於下單後 3 天內取消訂單。" });
    expect(r).toMatchObject({ ok: true, relocated: false });
  });

  test("accepts short quotes: no minimum length", () => {
    expect(index.verify({ file: "prd.md", lineStart: 4, lineEnd: 4, quote: "SKU" })).toMatchObject({ ok: true });
  });

  test("normalizes full-width characters and whitespace", () => {
    const r = index.verify({ file: "prd.md", lineStart: 2, lineEnd: 3, quote: "會員可於下單後　３　天內取消訂單。  取消後" });
    expect(r).toMatchObject({ ok: true, relocated: false });
  });

  test("relocates a quote that occurs exactly once elsewhere", () => {
    const r = index.verify({ file: "prd.md", lineStart: 1, lineEnd: 1, quote: "取消後應退款至原付款方式" });
    expect(r).toEqual({ ok: true, relocated: true, evidence: { file: "prd.md", lineStart: 3, lineEnd: 3, quote: "取消後應退款至原付款方式" } });
  });

  test("does not relocate an ambiguous quote", () => {
    const r = index.verify({ file: "prd.md", lineStart: 1, lineEnd: 1, quote: "SKU" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/appears 2 times/);
  });

  test("a quote may span blank lines, which count as a single space like any other line break", () => {
    const spec = new SourceIndex([
      { path: "spec.md", converted: false, text: "# Guide\n\n### New Endpoint: `POST /collect`\n\nSubmit CPE inventory.\n\n\nAuth: X-API-Key" },
    ]);
    const quote = "### New Endpoint: `POST /collect`\n\nSubmit CPE inventory.";
    expect(spec.verify({ file: "spec.md", lineStart: 3, lineEnd: 5, quote })).toMatchObject({ ok: true, relocated: false });
    expect(spec.verify({ file: "spec.md", lineStart: 1, lineEnd: 1, quote })).toEqual({ ok: true, relocated: true, evidence: { file: "spec.md", lineStart: 3, lineEnd: 5, quote } });
    expect(spec.verify({ file: "spec.md", lineStart: 5, lineEnd: 8, quote: "Submit CPE inventory. Auth: X-API-Key" })).toMatchObject({ ok: true, relocated: false });
  });

  test("rejects invented quotes and unknown files", () => {
    expect(index.verify({ file: "prd.md", lineStart: 2, lineEnd: 2, quote: "7 天內可取消" }).ok).toBe(false);
    expect(index.verify({ file: "nope.md", lineStart: 1, lineEnd: 1, quote: "x" }).ok).toBe(false);
  });
});
