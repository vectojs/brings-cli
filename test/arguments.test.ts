import { describe, expect, test } from "bun:test";

import { parseArguments, UsageError } from "../src/arguments";

const file = "./design.brings.json";
const node = "11111111-1111-4111-8111-111111111111";

describe("parseArguments", () => {
  test("parses every named mutation family", () => {
    const cases = [
      ["frame", "create", file, "--x", "1", "--y", "2"],
      ["rectangle", "create", file, "--x", "1", "--y", "2"],
      ["text", "create", file, "--x", "1", "--y", "2", "--content", "Hello"],
      ["node", "set", file, "--node", node, "--name", "Hero"],
      [
        "node",
        "transform",
        file,
        "--node",
        node,
        "--translate-x",
        "3",
        "--translate-y",
        "4",
      ],
      ["node", "delete", file, "--node", node],
      [
        "node",
        "group",
        file,
        "--node",
        node,
        "--node",
        "22222222-2222-4222-8222-222222222222",
      ],
      ["node", "ungroup", file, "--node", node],
      [
        "layer",
        "move",
        file,
        "--node",
        node,
        "--parent",
        "null",
        "--index",
        "0",
      ],
    ];
    const operations = [
      "frame.create",
      "rectangle.create",
      "text.create",
      "node.set",
      "node.transform",
      "node.delete",
      "node.group",
      "node.ungroup",
      "layer.move",
    ] as const;

    for (const [index, args] of cases.entries()) {
      const parsed = parseArguments([...args, "--expected-revision", "0"]);
      expect(parsed.kind).toBe("mutation");
      if (parsed.kind === "mutation")
        expect(parsed.intent.operation).toBe(operations[index]);
    }
  });

  test("requires safe revisions, finite numbers, explicit lowercase booleans, and non-empty patches", () => {
    const invalid = [
      ["frame", "create", file, "--x", "0", "--y", "0"],
      [
        "frame",
        "create",
        file,
        "--x",
        "Infinity",
        "--y",
        "0",
        "--expected-revision",
        "0",
      ],
      [
        "node",
        "set",
        file,
        "--node",
        node,
        "--visible",
        "TRUE",
        "--expected-revision",
        "0",
      ],
      ["node", "set", file, "--node", node, "--expected-revision", "0"],
      [
        "node",
        "delete",
        file,
        "--node",
        node,
        "--expected-revision",
        "9007199254740992",
      ],
    ];
    for (const args of invalid)
      expect(() => parseArguments(args)).toThrow(UsageError);
  });

  test("rejects unknown flags and incomplete stroke or transform pairs", () => {
    const invalid = [
      ["frame", "create", file, "--x", "0", "--y", "0", "--wat", "1"],
      ["node", "set", file, "--node", node, "--stroke-width", "2"],
      ["node", "set", file, "--node", node, "--stroke-color", "#ffffff"],
      ["node", "transform", file, "--node", node, "--translate-x", "2"],
    ];
    for (const args of invalid) {
      expect(() =>
        parseArguments([...args, "--expected-revision", "0"]),
      ).toThrow(UsageError);
    }
  });
});
