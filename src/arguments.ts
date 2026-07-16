import type {
  NodePropertyPatchInput,
  SolidPaintInput,
} from "@vectojs/brings-core";

import { PaintArgumentError, parsePaint } from "./paint";

export type AutomationOperation =
  | "frame.create"
  | "rectangle.create"
  | "text.create"
  | "node.set"
  | "node.transform"
  | "node.delete"
  | "node.group"
  | "node.ungroup"
  | "layer.move";

type MutationBase = Readonly<{
  file: string;
  expectedRevision: number;
  dryRun: boolean;
  json: boolean;
}>;

type Placement = Readonly<{
  pageId?: string;
  parentId?: string | null;
  index?: number;
}>;

export type AutomationIntent =
  | (MutationBase &
      Placement &
      Readonly<{
        operation: "frame.create";
        id?: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }>)
  | (MutationBase &
      Placement &
      Readonly<{
        operation: "rectangle.create";
        id?: string;
        x: number;
        y: number;
        width: number;
        height: number;
      }>)
  | (MutationBase &
      Placement &
      Readonly<{
        operation: "text.create";
        id?: string;
        x: number;
        y: number;
        content: string;
      }>)
  | (MutationBase &
      Readonly<{
        operation: "node.set";
        nodeId: string;
        patch: NodePropertyPatchInput;
      }>)
  | (MutationBase &
      Readonly<{
        operation: "node.transform";
        nodeIds: readonly string[];
        delta: readonly [number, number, number, number, number, number];
      }>)
  | (MutationBase &
      Readonly<{ operation: "node.delete"; nodeIds: readonly string[] }>)
  | (MutationBase &
      Readonly<{
        operation: "node.group";
        nodeIds: readonly string[];
        id?: string;
      }>)
  | (MutationBase & Readonly<{ operation: "node.ungroup"; nodeId: string }>)
  | (MutationBase &
      Readonly<{
        operation: "layer.move";
        nodeIds: readonly string[];
        pageId?: string;
        parentId: string | null;
        index: number;
      }>);

export type CliRequest =
  | Readonly<{ kind: "help" }>
  | Readonly<{ kind: "create"; file: string; force: boolean; json: boolean }>
  | Readonly<{ kind: "inspect"; file: string; json: boolean }>
  | Readonly<{ kind: "mutation"; intent: AutomationIntent }>;

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

type Flags = Map<string, string[]>;

const UUID =
  /^[\da-f]{8}-[\da-f]{4}-[1-5][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

function fail(code: string, message: string): never {
  throw new UsageError(code, message);
}

function readFlags(
  tokens: readonly string[],
  booleans: ReadonlySet<string>,
): Flags {
  const flags: Flags = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index];
    if (name === undefined || !name.startsWith("--")) {
      fail(
        "argument.unexpected",
        `unexpected positional argument ${JSON.stringify(name)}`,
      );
    }
    if (booleans.has(name)) {
      const values = flags.get(name) ?? [];
      values.push("true");
      flags.set(name, values);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail("argument.value", `${name} requires a value`);
    }
    const values = flags.get(name) ?? [];
    values.push(value);
    flags.set(name, values);
    index += 1;
  }
  return flags;
}

function assertAllowed(flags: Flags, allowed: readonly string[]): void {
  const names = new Set(allowed);
  for (const name of flags.keys()) {
    if (!names.has(name)) fail("argument.unknown", `unknown option ${name}`);
  }
}

function optional(flags: Flags, name: string): string | undefined {
  const values = flags.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1)
    fail("argument.duplicate", `${name} may be supplied once`);
  return values[0];
}

function required(flags: Flags, name: string): string {
  const value = optional(flags, name);
  if (value === undefined) fail("argument.required", `${name} is required`);
  return value;
}

function repeated(flags: Flags, name: string, minimum = 1): string[] {
  const values = flags.get(name) ?? [];
  if (values.length < minimum)
    fail("argument.required", `${name} requires at least ${minimum} value(s)`);
  return values;
}

function numberValue(value: string, name: string): number {
  if (value.trim() === "") fail("argument.number", `${name} must be finite`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    fail("argument.number", `${name} must be finite`);
  return parsed;
}

function optionalNumber(flags: Flags, name: string): number | undefined {
  const value = optional(flags, name);
  return value === undefined ? undefined : numberValue(value, name);
}

function integerValue(value: string, name: string, minimum = 0): number {
  const parsed = numberValue(value, name);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    fail("argument.integer", `${name} must be a safe integer >= ${minimum}`);
  }
  return parsed;
}

function booleanValue(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  fail("argument.boolean", `${name} must be true or false`);
}

function uuidValue(value: string, name: string): string {
  if (!UUID.test(value))
    fail("argument.uuid", `${name} must be a lowercase RFC-4122 UUID`);
  return value;
}

function nullableUuid(value: string, name: string): string | null {
  return value === "null" ? null : uuidValue(value, name);
}

function common(flags: Flags, file: string): MutationBase {
  return {
    file,
    expectedRevision: integerValue(
      required(flags, "--expected-revision"),
      "--expected-revision",
    ),
    dryRun: flags.has("--dry-run"),
    json: flags.has("--json"),
  };
}

function placement(flags: Flags): Placement {
  const page = optional(flags, "--page");
  const parent = optional(flags, "--parent");
  const index = optional(flags, "--index");
  return {
    ...(page === undefined ? {} : { pageId: uuidValue(page, "--page") }),
    ...(parent === undefined
      ? {}
      : { parentId: nullableUuid(parent, "--parent") }),
    ...(index === undefined ? {} : { index: integerValue(index, "--index") }),
  };
}

const MUTATION_COMMON = ["--expected-revision", "--dry-run", "--json"];
const PLACEMENT = ["--page", "--parent", "--index"];

function parseCreation(
  operation: "frame.create" | "rectangle.create" | "text.create",
  file: string,
  tokens: readonly string[],
): AutomationIntent {
  const flags = readFlags(tokens, new Set(["--dry-run", "--json"]));
  const dimensions = operation === "text.create" ? [] : ["--width", "--height"];
  const content = operation === "text.create" ? ["--content"] : [];
  assertAllowed(flags, [
    ...MUTATION_COMMON,
    ...PLACEMENT,
    "--id",
    "--x",
    "--y",
    ...dimensions,
    ...content,
  ]);
  const id = optional(flags, "--id");
  const base = {
    ...common(flags, file),
    ...placement(flags),
    ...(id === undefined ? {} : { id: uuidValue(id, "--id") }),
    x: numberValue(required(flags, "--x"), "--x"),
    y: numberValue(required(flags, "--y"), "--y"),
  };
  if (operation === "frame.create") {
    return {
      ...base,
      operation,
      width: optionalNumber(flags, "--width") ?? 400,
      height: optionalNumber(flags, "--height") ?? 300,
    };
  }
  if (operation === "rectangle.create") {
    return {
      ...base,
      operation,
      width: optionalNumber(flags, "--width") ?? 120,
      height: optionalNumber(flags, "--height") ?? 80,
    };
  }
  return { ...base, operation, content: required(flags, "--content") };
}

function parseRadii(value: string): readonly [number, number, number, number] {
  const parts = value.split(",");
  if (parts.length !== 4)
    fail("argument.radii", "--corner-radii requires a,b,c,d");
  return parts.map((part) => numberValue(part, "--corner-radii")) as [
    number,
    number,
    number,
    number,
  ];
}

function paintValue(value: string, name: string): SolidPaintInput | null {
  try {
    return parsePaint(value);
  } catch (error) {
    if (error instanceof PaintArgumentError)
      fail(error.code, `${name} has an invalid paint`);
    throw error;
  }
}

function parseSet(file: string, tokens: readonly string[]): AutomationIntent {
  const flags = readFlags(tokens, new Set(["--dry-run", "--json"]));
  const propertyNames = [
    "--name",
    "--visible",
    "--locked",
    "--opacity",
    "--width",
    "--height",
    "--corner-radii",
    "--fill",
    "--background",
    "--stroke-color",
    "--stroke-width",
    "--clip-children",
    "--content",
    "--font-family",
    "--font-weight",
    "--font-size",
    "--line-height",
    "--horizontal-align",
    "--layout-mode",
  ];
  assertAllowed(flags, [...MUTATION_COMMON, "--node", ...propertyNames]);
  const patch: Record<string, unknown> = {};
  const assign = (
    flag: string,
    key: string,
    convert: (value: string) => unknown = (value) => value,
  ) => {
    const value = optional(flags, flag);
    if (value !== undefined) patch[key] = convert(value);
  };
  assign("--name", "name");
  assign("--visible", "visible", (value) => booleanValue(value, "--visible"));
  assign("--locked", "locked", (value) => booleanValue(value, "--locked"));
  assign("--opacity", "opacity", (value) => numberValue(value, "--opacity"));
  assign("--width", "width", (value) => numberValue(value, "--width"));
  assign("--height", "height", (value) => numberValue(value, "--height"));
  assign("--corner-radii", "cornerRadii", parseRadii);
  assign("--fill", "fill", (value) => paintValue(value, "--fill"));
  assign("--background", "background", (value) =>
    paintValue(value, "--background"),
  );
  assign("--clip-children", "clipChildren", (value) =>
    booleanValue(value, "--clip-children"),
  );
  assign("--content", "content");
  assign("--font-weight", "fontWeight", (value) =>
    integerValue(value, "--font-weight", 100),
  );
  assign("--font-size", "fontSize", (value) =>
    numberValue(value, "--font-size"),
  );
  assign("--line-height", "lineHeight", (value) =>
    numberValue(value, "--line-height"),
  );
  assign("--horizontal-align", "horizontalAlign", (value) => {
    if (!["left", "center", "right"].includes(value))
      fail("argument.enum", "invalid horizontal alignment");
    return value;
  });
  assign("--layout-mode", "layoutMode", (value) => {
    if (!["fixedBox", "autoWidth"].includes(value))
      fail("argument.enum", "invalid layout mode");
    return value;
  });
  const families = flags.get("--font-family");
  if (families !== undefined) patch.fontFamilies = [...families];
  const strokeColor = optional(flags, "--stroke-color");
  const strokeWidth = optional(flags, "--stroke-width");
  if ((strokeColor === undefined) !== (strokeWidth === undefined)) {
    fail(
      "argument.stroke",
      "--stroke-color and --stroke-width must be supplied together",
    );
  }
  if (strokeColor !== undefined && strokeWidth !== undefined) {
    const paint = paintValue(strokeColor, "--stroke-color");
    patch.stroke =
      paint === null
        ? null
        : { paint, width: numberValue(strokeWidth, "--stroke-width") };
  }
  if (Object.keys(patch).length === 0)
    fail("argument.patch-empty", "node set requires a property flag");
  return {
    ...common(flags, file),
    operation: "node.set",
    nodeId: uuidValue(required(flags, "--node"), "--node"),
    patch: patch as NodePropertyPatchInput,
  };
}

function parseTransform(
  file: string,
  tokens: readonly string[],
): AutomationIntent {
  const flags = readFlags(tokens, new Set(["--dry-run", "--json"]));
  assertAllowed(flags, [
    ...MUTATION_COMMON,
    "--node",
    "--translate-x",
    "--translate-y",
    "--scale-x",
    "--scale-y",
    "--origin-x",
    "--origin-y",
  ]);
  const txValue = optional(flags, "--translate-x");
  const tyValue = optional(flags, "--translate-y");
  if ((txValue === undefined) !== (tyValue === undefined)) {
    fail("argument.transform", "translation requires both axes");
  }
  const scaleNames = ["--scale-x", "--scale-y", "--origin-x", "--origin-y"];
  const scaleValues = scaleNames.map((name) => optional(flags, name));
  const scaling = scaleValues.some((value) => value !== undefined);
  if (scaling && scaleValues.some((value) => value === undefined)) {
    fail("argument.transform", "scaling requires both scale and origin axes");
  }
  if (!scaling && txValue === undefined)
    fail("argument.transform", "a translation or scale is required");
  const tx = txValue === undefined ? 0 : numberValue(txValue, "--translate-x");
  const ty = tyValue === undefined ? 0 : numberValue(tyValue, "--translate-y");
  let delta: [number, number, number, number, number, number] = [
    1,
    0,
    0,
    1,
    tx,
    ty,
  ];
  if (scaling) {
    const sx = numberValue(scaleValues[0]!, "--scale-x");
    const sy = numberValue(scaleValues[1]!, "--scale-y");
    const ox = numberValue(scaleValues[2]!, "--origin-x");
    const oy = numberValue(scaleValues[3]!, "--origin-y");
    delta = [sx, 0, 0, sy, ox * (1 - sx) + tx, oy * (1 - sy) + ty];
  }
  return {
    ...common(flags, file),
    operation: "node.transform",
    nodeIds: repeated(flags, "--node").map((value) =>
      uuidValue(value, "--node"),
    ),
    delta,
  };
}

function parseSimple(
  operation: AutomationOperation,
  file: string,
  tokens: readonly string[],
): AutomationIntent {
  const flags = readFlags(tokens, new Set(["--dry-run", "--json"]));
  if (operation === "node.delete") {
    assertAllowed(flags, [...MUTATION_COMMON, "--node"]);
    return {
      ...common(flags, file),
      operation,
      nodeIds: repeated(flags, "--node").map((value) =>
        uuidValue(value, "--node"),
      ),
    };
  }
  if (operation === "node.group") {
    assertAllowed(flags, [...MUTATION_COMMON, "--node", "--id"]);
    const id = optional(flags, "--id");
    return {
      ...common(flags, file),
      operation,
      nodeIds: repeated(flags, "--node", 2).map((value) =>
        uuidValue(value, "--node"),
      ),
      ...(id === undefined ? {} : { id: uuidValue(id, "--id") }),
    };
  }
  if (operation === "node.ungroup") {
    assertAllowed(flags, [...MUTATION_COMMON, "--node"]);
    return {
      ...common(flags, file),
      operation,
      nodeId: uuidValue(required(flags, "--node"), "--node"),
    };
  }
  if (operation === "layer.move") {
    assertAllowed(flags, [
      ...MUTATION_COMMON,
      "--node",
      "--parent",
      "--index",
      "--page",
    ]);
    const page = optional(flags, "--page");
    return {
      ...common(flags, file),
      operation,
      nodeIds: repeated(flags, "--node").map((value) =>
        uuidValue(value, "--node"),
      ),
      parentId: nullableUuid(required(flags, "--parent"), "--parent"),
      index: integerValue(required(flags, "--index"), "--index"),
      ...(page === undefined ? {} : { pageId: uuidValue(page, "--page") }),
    };
  }
  fail("argument.command", `unsupported operation ${operation}`);
}

/** Parse one CLI invocation without touching the filesystem. */
export function parseArguments(args: readonly string[]): CliRequest {
  if (args.length === 1 && ["help", "--help", "-h"].includes(args[0]!)) {
    return { kind: "help" };
  }
  if (args[0] === "create") {
    const file = args[1];
    if (file === undefined) fail("argument.file", "create requires a file");
    const flags = readFlags(args.slice(2), new Set(["--force", "--json"]));
    assertAllowed(flags, ["--force", "--json"]);
    return {
      kind: "create",
      file,
      force: flags.has("--force"),
      json: flags.has("--json"),
    };
  }
  if (args[0] === "inspect") {
    const file = args[1];
    if (file === undefined) fail("argument.file", "inspect requires a file");
    const flags = readFlags(args.slice(2), new Set(["--json"]));
    assertAllowed(flags, ["--json"]);
    return { kind: "inspect", file, json: flags.has("--json") };
  }

  const first = args[0];
  const second = args[1];
  const file = args[2];
  if (first === undefined || second === undefined || file === undefined) {
    fail("argument.command", "expected a named Brings command");
  }
  const tokens = args.slice(3);
  if (second === "create" && ["frame", "rectangle", "text"].includes(first)) {
    return {
      kind: "mutation",
      intent: parseCreation(`${first}.create` as "frame.create", file, tokens),
    };
  }
  if (first === "node" && second === "set") {
    return { kind: "mutation", intent: parseSet(file, tokens) };
  }
  if (first === "node" && second === "transform") {
    return { kind: "mutation", intent: parseTransform(file, tokens) };
  }
  const operation =
    first === "node" && ["delete", "group", "ungroup"].includes(second)
      ? (`node.${second}` as AutomationOperation)
      : first === "layer" && second === "move"
        ? "layer.move"
        : undefined;
  if (operation !== undefined) {
    return { kind: "mutation", intent: parseSimple(operation, file, tokens) };
  }
  fail("argument.command", `unknown command ${first} ${second}`);
}
