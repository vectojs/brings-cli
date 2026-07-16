#!/usr/bin/env bun
import { createDocumentStore } from "@vectojs/brings-core";

import { parseArguments, UsageError } from "./arguments";
import { executeIntent, type AutomationResult } from "./automation";
import {
  createDocumentFile,
  inspectDocumentFile,
  type DocumentFileFailure,
} from "./documentFile";

const usage = `Usage:
  brings create <file> [--force] [--json]
  brings inspect <file> [--json]
  brings <frame|rectangle|text> create <file> [options] --expected-revision <n>
  brings node <set|transform|delete|group|ungroup> <file> [options] --expected-revision <n>
  brings layer move <file> [options] --expected-revision <n>`;

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printMutation(result: AutomationResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }
  if (!result.ok) {
    console.error(`${result.error.code} (${result.error.path})`);
    return;
  }
  console.log(
    `${result.operation}: revision ${result.revision.before} -> ${result.revision.after}; affected ${result.affectedNodeIds.join(", ") || "none"}`,
  );
  for (const warning of result.warnings) {
    console.error(
      `${warning.code} (${warning.path}): document changed; recover the sidecar lock manually`,
    );
  }
}

function fileFailure(
  result: DocumentFileFailure,
  file: string,
): Record<string, unknown> {
  return {
    ok: false,
    file,
    error: result.error,
    revision: result.revision,
    warnings: result.warnings,
  };
}

export async function run(args: readonly string[]): Promise<number> {
  let request;
  try {
    request = parseArguments(args);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(usage);
      return 2;
    }
    throw error;
  }

  if (request.kind === "mutation") {
    const result = await executeIntent(request.intent);
    printMutation(result, request.intent.json);
    return result.ok ? 0 : 1;
  }

  if (request.kind === "create") {
    const documentId = crypto.randomUUID();
    const pageId = crypto.randomUUID();
    const created = createDocumentStore({
      id: documentId,
      name: "Untitled",
      initialPage: { id: pageId, name: "Page 1" },
    });
    if (!created.ok) {
      const failure = {
        ok: false,
        file: request.file,
        error: created.error,
        revision: { expected: null, actual: null },
        warnings: [],
      };
      request.json
        ? printJson(failure)
        : console.error(`${created.error.code} (${created.error.path})`);
      return 1;
    }
    const written = await createDocumentFile({
      path: request.file,
      document: created.value.snapshot().document,
      force: request.force,
    });
    if (!written.ok) {
      const output = fileFailure(written, request.file);
      request.json
        ? printJson(output)
        : console.error(`${written.error.code} (${written.error.path})`);
      return 1;
    }
    printJson({
      file: request.file,
      documentId,
      pageId,
      revision: 0,
      warnings: written.warnings,
    });
    return 0;
  }

  const inspected = await inspectDocumentFile(request.file);
  if (!inspected.ok) {
    const output = fileFailure(inspected, request.file);
    request.json
      ? printJson(output)
      : console.error(`${inspected.error.code} (${inspected.error.path})`);
    return 1;
  }
  const document = inspected.value.document;
  printJson({
    id: document.id,
    name: document.name,
    revision: document.revision,
    pages: document.pages.length,
    nodes: document.nodes.length,
  });
  return 0;
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));
