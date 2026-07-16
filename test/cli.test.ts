import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, ".tmp-cli");
const cli = join(import.meta.dir, "../src/cli.ts");
const frameId = "11111111-1111-4111-8111-111111111111";
const rectangleId = "22222222-2222-4222-8222-222222222222";
const textId = "33333333-3333-4333-8333-333333333333";
const groupId = "44444444-4444-4444-8444-444444444444";

type Invocation = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

async function invoke(args: readonly string[]): Promise<Invocation> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function json(args: readonly string[]): Promise<Record<string, any>> {
  const result = await invoke([...args, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("brings executable", () => {
  test("prints command help without accessing a document", async () => {
    const result = await invoke(["--help"]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("brings rectangle create");
    expect(result.stdout).toContain("--expected-revision");
  });

  test("creates safely and inspects validated revision metadata", async () => {
    const file = join(root, "design.json");
    const created = await json(["create", file]);
    expect(created).toMatchObject({ file, revision: 0 });
    expect(created.documentId).toBeString();
    expect(created.pageId).toBeString();

    const inspected = await json(["inspect", file]);
    expect(inspected).toMatchObject({
      id: created.documentId,
      name: "Untitled",
      revision: 0,
      pages: 1,
      nodes: 0,
    });

    const rejected = await invoke(["create", file, "--json"]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      ok: false,
      error: { code: "document.exists", path: "/file" },
    });
  });

  test("executes all nine named intentions with stable envelopes", async () => {
    const file = join(root, "design.json");
    await json(["create", file]);

    const operations: Array<
      readonly [string, readonly string[], readonly string[]]
    > = [
      [
        "frame.create",
        ["frame", "create", file, "--x", "20", "--y", "30", "--id", frameId],
        [frameId],
      ],
      [
        "rectangle.create",
        [
          "rectangle",
          "create",
          file,
          "--x",
          "50",
          "--y",
          "60",
          "--id",
          rectangleId,
        ],
        [rectangleId],
      ],
      [
        "text.create",
        [
          "text",
          "create",
          file,
          "--x",
          "80",
          "--y",
          "90",
          "--content",
          "Hello",
          "--id",
          textId,
        ],
        [textId],
      ],
      [
        "node.set",
        ["node", "set", file, "--node", rectangleId, "--name", "Hero"],
        [rectangleId],
      ],
      [
        "node.transform",
        [
          "node",
          "transform",
          file,
          "--node",
          rectangleId,
          "--translate-x",
          "10",
          "--translate-y",
          "5",
        ],
        [rectangleId],
      ],
      [
        "node.group",
        [
          "node",
          "group",
          file,
          "--node",
          rectangleId,
          "--node",
          textId,
          "--id",
          groupId,
        ],
        [rectangleId, textId],
      ],
      [
        "layer.move",
        [
          "layer",
          "move",
          file,
          "--node",
          groupId,
          "--parent",
          frameId,
          "--index",
          "0",
        ],
        [groupId],
      ],
      ["node.ungroup", ["node", "ungroup", file, "--node", groupId], [groupId]],
      [
        "node.delete",
        ["node", "delete", file, "--node", rectangleId],
        [rectangleId],
      ],
    ];

    for (const [
      revision,
      [operation, args, explicit],
    ] of operations.entries()) {
      const result = await json([
        ...args,
        "--expected-revision",
        String(revision),
      ]);
      expect(result).toMatchObject({
        ok: true,
        operation,
        file,
        dryRun: false,
        revision: { before: revision, after: revision + 1 },
        warnings: [],
      });
      expect(result.affectedNodeIds.slice(0, explicit.length)).toEqual(
        explicit,
      );
    }

    const persisted = JSON.parse(await readFile(file, "utf8"));
    expect(persisted.revision).toBe(operations.length);
    expect(
      persisted.nodes.some((node: { id: string }) => node.id === rectangleId),
    ).toBeFalse();
  });

  test("returns generated dry-run IDs for exact durable replay", async () => {
    const file = join(root, "design.json");
    await json(["create", file]);
    const preview = await json([
      "rectangle",
      "create",
      file,
      "--x",
      "1",
      "--y",
      "2",
      "--expected-revision",
      "0",
      "--dry-run",
    ]);
    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      revision: { before: 0, after: 1 },
    });
    expect(preview.generatedNodeIds).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8")).revision).toBe(0);

    const replay = await json([
      "rectangle",
      "create",
      file,
      "--x",
      "1",
      "--y",
      "2",
      "--id",
      preview.generatedNodeIds[0],
      "--expected-revision",
      "0",
    ]);
    expect(replay.generatedNodeIds).toEqual([]);
    expect(replay.affectedNodeIds).toContain(preview.generatedNodeIds[0]);
  });

  test("uses exit 2 for usage and exit 1 for operational or Core failures", async () => {
    const file = join(root, "design.json");
    await json(["create", file]);
    const usage = await invoke([
      "rectangle",
      "create",
      file,
      "--x",
      "bad",
      "--y",
      "2",
      "--expected-revision",
      "0",
    ]);
    expect(usage.exitCode).toBe(2);
    expect(usage.stderr).toContain("argument.number");

    const conflict = await invoke([
      "node",
      "delete",
      file,
      "--node",
      rectangleId,
      "--expected-revision",
      "2",
      "--json",
    ]);
    expect(conflict.exitCode).toBe(1);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      ok: false,
      operation: "node.delete",
      error: { code: "document.revision-conflict", path: "/revision" },
      revision: { expected: 2, actual: 0 },
    });
  });
});
