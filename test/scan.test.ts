import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { scanDirectory } from "../src/source/scan.ts";

function tree(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "xplan-scan-"));
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "x");
  }
  return dir;
}

describe("scanDirectory Reference Documents", () => {
  test("everything under the top-level references/ directory is a Reference Document", async () => {
    const dir = tree(["req.md", "references/api.md", "references/db/tbl_a.md", "references/notes.xlsx", "docs/references/x.md"]);
    const scan = await scanDirectory(dir);
    expect(scan.files).toEqual(["docs/references/x.md", "references/api.md", "references/db/tbl_a.md", "req.md"]);
    expect(scan.reference).toEqual(["references/api.md", "references/db/tbl_a.md"]);
  });

  test("--reference globs add to the references/ directory", async () => {
    const dir = tree(["req.md", "schema.md", "references/api.md"]);
    expect((await scanDirectory(dir, { reference: ["schema.md"] })).reference).toEqual(["references/api.md", "schema.md"]);
  });

  test("without references/ or globs nothing is a Reference Document", async () => {
    expect((await scanDirectory(tree(["req.md", "faq.md"]))).reference).toEqual([]);
  });
});
