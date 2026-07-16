import {
  type BringsDocument,
  type DocumentCommandInput,
  type EditorSnapshot,
  type SceneNode,
  type SolidPaintInput,
} from "@vectojs/brings-core";

import type { AutomationIntent, AutomationOperation } from "./arguments";
import {
  mutateDocumentFile,
  type AutomationWarning,
  type DocumentFileFailure,
} from "./documentFile";
import { parsePaint } from "./paint";

export type AutomationSuccess = Readonly<{
  ok: true;
  operation: AutomationOperation;
  file: string;
  dryRun: boolean;
  revision: Readonly<{ before: number; after: number }>;
  affectedNodeIds: readonly string[];
  generatedNodeIds: readonly string[];
  warnings: readonly AutomationWarning[];
  selection: Readonly<{
    nodeIds: readonly string[];
    activeNodeId: string | null;
  }>;
}>;

export type AutomationFailure = Readonly<{
  ok: false;
  operation: AutomationOperation;
  file: string;
  error: Readonly<{ code: string; path: string }>;
  revision: Readonly<{ expected: number | null; actual: number | null }>;
  warnings: readonly AutomationWarning[];
}>;

export type AutomationResult = AutomationSuccess | AutomationFailure;

type CommandPlan = Readonly<{
  command: DocumentCommandInput;
  explicitNodeIds: readonly string[];
  generatedNodeIds: readonly string[];
}>;

function solid(value: string): SolidPaintInput {
  const paint = parsePaint(value);
  if (paint === null) throw new Error("internal solid paint cannot be none");
  return paint;
}

function appendIndex(
  document: BringsDocument,
  pageId: string,
  parentId: string | null,
): number {
  if (parentId === null) {
    return (
      document.pages.find((page) => page.id === pageId)?.rootNodeIds.length ?? 0
    );
  }
  const parent = document.nodes.find((node) => node.id === parentId);
  return parent?.type === "frame" || parent?.type === "group"
    ? parent.childIds.length
    : 0;
}

function creationPlacement(
  intent: Extract<
    AutomationIntent,
    { operation: "frame.create" | "rectangle.create" | "text.create" }
  >,
  document: BringsDocument,
): Readonly<{ pageId: string; parentId: string | null; index: number }> {
  const pageId = intent.pageId ?? document.activePageId;
  const parentId = intent.parentId ?? null;
  return {
    pageId,
    parentId,
    index: intent.index ?? appendIndex(document, pageId, parentId),
  };
}

function commandForIntent(
  intent: AutomationIntent,
  before: BringsDocument,
): CommandPlan {
  if (intent.operation === "frame.create") {
    const generated = intent.id === undefined;
    const id = intent.id ?? crypto.randomUUID();
    return {
      command: {
        kind: "create-frame",
        ...creationPlacement(intent, before),
        frame: {
          id,
          name: "Frame",
          visible: true,
          locked: false,
          opacity: 1,
          transform: [1, 0, 0, 1, intent.x, intent.y],
          width: intent.width,
          height: intent.height,
          cornerRadii: [0, 0, 0, 0],
          background: solid("#ffffffff"),
          stroke: { paint: solid("#ccd6e6ff"), width: 1 },
          clipChildren: false,
        },
      },
      explicitNodeIds: [id],
      generatedNodeIds: generated ? [id] : [],
    };
  }
  if (intent.operation === "rectangle.create") {
    const generated = intent.id === undefined;
    const id = intent.id ?? crypto.randomUUID();
    return {
      command: {
        kind: "create-rectangle",
        ...creationPlacement(intent, before),
        rectangle: {
          id,
          name: "Rectangle",
          visible: true,
          locked: false,
          opacity: 1,
          transform: [1, 0, 0, 1, intent.x, intent.y],
          width: intent.width,
          height: intent.height,
          cornerRadii: [8, 8, 8, 8],
          fill: solid("#2e73f2ff"),
          stroke: null,
        },
      },
      explicitNodeIds: [id],
      generatedNodeIds: generated ? [id] : [],
    };
  }
  if (intent.operation === "text.create") {
    const generated = intent.id === undefined;
    const id = intent.id ?? crypto.randomUUID();
    return {
      command: {
        kind: "create-text",
        ...creationPlacement(intent, before),
        text: {
          id,
          name: "Text",
          visible: true,
          locked: false,
          opacity: 1,
          transform: [1, 0, 0, 1, intent.x, intent.y],
          content: intent.content,
          fontFamilies: ["Inter"],
          fontWeight: 400,
          fontSize: 16,
          lineHeight: 24,
          horizontalAlign: "left",
          layoutMode: "autoWidth",
          width: 160,
          height: 24,
          fill: solid("#121721ff"),
        },
      },
      explicitNodeIds: [id],
      generatedNodeIds: generated ? [id] : [],
    };
  }
  if (intent.operation === "node.set") {
    return {
      command: {
        kind: "set-node-properties",
        nodeIds: [intent.nodeId],
        patch: intent.patch,
      },
      explicitNodeIds: [intent.nodeId],
      generatedNodeIds: [],
    };
  }
  if (intent.operation === "node.transform") {
    return {
      command: {
        kind: "apply-transform-delta",
        nodeIds: intent.nodeIds,
        delta: intent.delta,
      },
      explicitNodeIds: intent.nodeIds,
      generatedNodeIds: [],
    };
  }
  if (intent.operation === "node.delete") {
    return {
      command: { kind: "delete-nodes", nodeIds: intent.nodeIds },
      explicitNodeIds: intent.nodeIds,
      generatedNodeIds: [],
    };
  }
  if (intent.operation === "node.group") {
    const generated = intent.id === undefined;
    const id = intent.id ?? crypto.randomUUID();
    return {
      command: {
        kind: "group-nodes",
        nodeIds: intent.nodeIds,
        group: { id, name: "Group" },
      },
      explicitNodeIds: intent.nodeIds,
      generatedNodeIds: generated ? [id] : [],
    };
  }
  if (intent.operation === "node.ungroup") {
    return {
      command: { kind: "ungroup-node", nodeId: intent.nodeId },
      explicitNodeIds: [intent.nodeId],
      generatedNodeIds: [],
    };
  }
  return {
    command: {
      kind: "move-nodes",
      nodeIds: intent.nodeIds,
      pageId: intent.pageId ?? before.activePageId,
      parentId: intent.parentId,
      index: intent.index,
    },
    explicitNodeIds: intent.nodeIds,
    generatedNodeIds: [],
  };
}

function changed(before: SceneNode, after: SceneNode): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function affectedNodeIds(
  before: BringsDocument,
  after: BringsDocument,
  explicit: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const append = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };
  explicit.forEach(append);
  const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
  const afterById = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of after.nodes) {
    const prior = beforeById.get(node.id);
    if (prior === undefined || changed(prior, node)) append(node.id);
  }
  for (const node of before.nodes) {
    if (!afterById.has(node.id)) append(node.id);
  }
  return result;
}

function failureEnvelope(
  intent: AutomationIntent,
  result: DocumentFileFailure,
): AutomationFailure {
  return {
    ok: false,
    operation: intent.operation,
    file: intent.file,
    error: result.error,
    revision: result.revision,
    warnings: result.warnings,
  };
}

/** Execute one parsed intention as exactly one Core document command. */
export async function executeIntent(
  intent: AutomationIntent,
): Promise<AutomationResult> {
  let plan: CommandPlan | undefined;
  const result = await mutateDocumentFile({
    path: intent.file,
    expectedRevision: intent.expectedRevision,
    dryRun: intent.dryRun,
    execute: (store, before) => {
      plan = commandForIntent(intent, before);
      return store.execute(plan.command);
    },
  });
  if (!result.ok) return failureEnvelope(intent, result);
  if (plan === undefined) {
    return failureEnvelope(intent, {
      ok: false,
      error: { code: "document.operation", path: "/" },
      revision: { expected: intent.expectedRevision, actual: null },
      warnings: result.warnings,
    });
  }
  return {
    ok: true,
    operation: intent.operation,
    file: intent.file,
    dryRun: intent.dryRun,
    revision: {
      before: result.value.beforeRevision,
      after: result.value.afterRevision,
    },
    affectedNodeIds: affectedNodeIds(
      result.value.before,
      result.value.after,
      plan.explicitNodeIds,
    ),
    generatedNodeIds: plan.generatedNodeIds,
    warnings: result.warnings,
    selection: result.value.selection,
  };
}
