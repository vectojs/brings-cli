import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { createDocumentStore } from "@vectojs/brings-core";

import {
  createDocumentFile,
  inspectDocumentFile,
  mutateDocumentFile,
} from "../src/documentFile";

const documentId = "11111111-1111-4111-8111-111111111111";
const pageId = "22222222-2222-4222-8222-222222222222";
const nodeId = "33333333-3333-4333-8333-333333333333";
const root = join(import.meta.dir, ".tmp-document-file");

function document() {
  const created = createDocumentStore({
    id: documentId,
    name: "Fixture",
    initialPage: { id: pageId, name: "Page 1" },
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value.snapshot().document;
}

async function writeDocument(path: string): Promise<string> {
  const bytes = `${JSON.stringify(document(), null, 2)}\n`;
  await writeFile(path, bytes, { mode: 0o640 });
  return bytes;
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("document file transactions", () => {
  test("inspects validated documents and rejects symlinks", async () => {
    const path = join(root, "design.json");
    await writeDocument(path);
    expect(await inspectDocumentFile(path)).toMatchObject({
      ok: true,
      value: { document: { id: documentId, revision: 0 } },
    });

    const alias = join(root, "alias.json");
    await symlink(path, alias);
    expect(await inspectDocumentFile(alias)).toMatchObject({
      ok: false,
      error: { code: "document.file-kind", path: "/file" },
    });
  });

  test("publishes new files without overwrite and force-replaces regular files", async () => {
    const path = join(root, "design.json");
    const first = await createDocumentFile({
      path,
      document: document(),
      force: false,
    });
    expect(first).toMatchObject({ ok: true, warnings: [] });
    const complete = await readFile(path, "utf8");
    expect(JSON.parse(complete)).toMatchObject({ id: documentId, revision: 0 });

    expect(
      await createDocumentFile({ path, document: document(), force: false }),
    ).toMatchObject({
      ok: false,
      error: { code: "document.exists", path: "/file" },
    });
    expect(
      await createDocumentFile({ path, document: document(), force: true }),
    ).toMatchObject({
      ok: true,
    });
  });

  test("keeps original bytes on stale revisions and dry runs", async () => {
    const path = join(root, "design.json");
    const before = await writeDocument(path);
    const stale = await mutateDocumentFile({
      path,
      expectedRevision: 2,
      dryRun: false,
      execute: () => {
        throw new Error("must not execute");
      },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: "document.revision-conflict", path: "/revision" },
      revision: { expected: 2, actual: 0 },
    });

    const dryRun = await mutateDocumentFile({
      path,
      expectedRevision: 0,
      dryRun: true,
      execute: (store) => {
        const result = store.execute({
          kind: "create-rectangle",
          pageId,
          parentId: null,
          index: 0,
          rectangle: {
            id: nodeId,
            name: "Rectangle",
            visible: true,
            locked: false,
            opacity: 1,
            transform: [1, 0, 0, 1, 10, 20],
            width: 120,
            height: 80,
            cornerRadii: [8, 8, 8, 8],
            fill: { type: "solid", r: 0, g: 0, b: 0, a: 1 },
            stroke: null,
          },
        });
        if (!result.ok) return result;
        return { ok: true as const, value: result.value };
      },
    });
    expect(dryRun).toMatchObject({
      ok: true,
      value: { beforeRevision: 0, afterRevision: 1 },
    });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  test("locks cooperating writers and preserves mode during atomic replacement", async () => {
    const path = join(root, "design.json");
    await writeDocument(path);
    await writeFile(`${path}.brings.lock`, "{}", { flag: "wx" });
    expect(
      await mutateDocumentFile({
        path,
        expectedRevision: 0,
        dryRun: false,
        execute: () => {
          throw new Error("must not execute");
        },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "document.locked", path: "/file" },
    });
    await rm(`${path}.brings.lock`);

    const result = await mutateDocumentFile({
      path,
      expectedRevision: 0,
      dryRun: false,
      execute: (store) => {
        const executed = store.execute({
          kind: "rename-page",
          pageId,
          name: "Renamed",
        });
        return executed.ok
          ? { ok: true as const, value: executed.value }
          : executed;
      },
    });
    expect(result).toMatchObject({ ok: true, value: { afterRevision: 1 } });
    expect((await stat(path)).mode & 0o777).toBe(0o640);
  });

  test("distinguishes lock release failures before and after commit", async () => {
    const dryPath = join(root, "dry.json");
    await writeDocument(dryPath);
    const beforeCommit = await mutateDocumentFile({
      path: dryPath,
      expectedRevision: 0,
      dryRun: true,
      faults: { beforeLockRelease: () => Promise.reject(new Error("fault")) },
      execute: (store) => ({ ok: true as const, value: store.snapshot() }),
    });
    expect(beforeCommit).toMatchObject({
      ok: false,
      error: { code: "document.lock-release-failed", path: "/file" },
    });

    const committedPath = join(root, "committed.json");
    await writeDocument(committedPath);
    const afterCommit = await mutateDocumentFile({
      path: committedPath,
      expectedRevision: 0,
      dryRun: false,
      faults: { beforeLockRelease: () => Promise.reject(new Error("fault")) },
      execute: (store) => {
        const executed = store.execute({
          kind: "rename-page",
          pageId,
          name: "Committed",
        });
        return executed.ok
          ? { ok: true as const, value: executed.value }
          : executed;
      },
    });
    expect(afterCommit).toMatchObject({
      ok: true,
      warnings: [{ code: "document.lock-release-failed", path: "/file" }],
    });
    expect(JSON.parse(await readFile(committedPath, "utf8"))).toMatchObject({
      revision: 1,
    });
  });

  test("preserves the primary failure and cleans temporary files after a publication fault", async () => {
    const path = join(root, "design.json");
    const before = await writeDocument(path);
    const result = await mutateDocumentFile({
      path,
      expectedRevision: 0,
      dryRun: false,
      faults: {
        beforePublish: () => Promise.reject(new Error("rename fault")),
      },
      execute: (store) => {
        const executed = store.execute({
          kind: "rename-page",
          pageId,
          name: "Never committed",
        });
        return executed.ok
          ? { ok: true as const, value: executed.value }
          : executed;
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "document.write", path: "/file" },
    });
    expect(await readFile(path, "utf8")).toBe(before);
    expect(
      (await Array.fromAsync(new Bun.Glob("*.tmp").scan(root))).length,
    ).toBe(0);
  });
});
