import {
  constants,
  link,
  lstat,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { hostname } from "node:os";

import {
  openDocumentStore,
  validateDocument,
  type BringsDocument,
  type BringsDocumentInput,
  type BringsDocumentStore,
  type BringsError,
  type EditorSnapshot,
  type Result,
} from "@vectojs/brings-core";

export type AutomationWarning = Readonly<{
  code: "document.lock-release-failed";
  path: "/file";
}>;

export type DocumentFileFailure = Readonly<{
  ok: false;
  error: BringsError;
  revision: Readonly<{ expected: number | null; actual: number | null }>;
  warnings: readonly AutomationWarning[];
}>;

export type DocumentFileSuccess<T> = Readonly<{
  ok: true;
  value: T;
  warnings: readonly AutomationWarning[];
}>;

export type DocumentFileResult<T> =
  | DocumentFileSuccess<T>
  | DocumentFileFailure;

export type TransactionFaults = Readonly<{
  beforeWriteTemp?: () => void | Promise<void>;
  beforePublish?: () => void | Promise<void>;
  beforeLockRelease?: () => void | Promise<void>;
}>;

type OwnedLock = Readonly<{ path: string; token: string }>;

type InternalResult<T> = DocumentFileResult<
  Readonly<{ committed: boolean; result: T }>
>;

const lockWarning: AutomationWarning = {
  code: "document.lock-release-failed",
  path: "/file",
};

function success<T>(value: T): DocumentFileSuccess<T> {
  return { ok: true, value, warnings: [] };
}

function failure(
  code: string,
  path = "/file",
  expected: number | null = null,
  actual: number | null = null,
): DocumentFileFailure {
  return {
    ok: false,
    error: { code, path },
    revision: { expected, actual },
    warnings: [],
  };
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function acquireLock(
  path: string,
): Promise<DocumentFileResult<OwnedLock>> {
  const lockPath = `${path}.brings.lock`;
  const token = crypto.randomUUID();
  let handle;
  try {
    handle = await open(
      lockPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(
      `${JSON.stringify({ version: 1, token, pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`,
      "utf8",
    );
    await handle.sync();
    return success({ path: lockPath, token });
  } catch (error) {
    if (errno(error) === "EEXIST") return failure("document.locked");
    return failure("document.lock");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function releaseLock(
  lock: OwnedLock,
  faults?: TransactionFaults,
): Promise<void> {
  await faults?.beforeLockRelease?.();
  const content = JSON.parse(await readFile(lock.path, "utf8")) as {
    token?: unknown;
  };
  if (content.token !== lock.token) throw new Error("lock ownership changed");
  await unlink(lock.path);
}

async function withLock<T>(
  path: string,
  faults: TransactionFaults | undefined,
  operation: () => Promise<InternalResult<T>>,
): Promise<DocumentFileResult<T>> {
  const acquired = await acquireLock(path);
  if (!acquired.ok) return acquired;
  let result: InternalResult<T>;
  try {
    result = await operation();
  } catch {
    result = failure("document.operation");
  }

  try {
    await releaseLock(acquired.value, faults);
  } catch {
    if (result.ok && result.value.committed) {
      return {
        ok: true,
        value: result.value.result,
        warnings: [lockWarning],
      };
    }
    if (result.ok) return failure("document.lock-release-failed");
    return { ...result, warnings: [...result.warnings, lockWarning] };
  }

  return result.ok
    ? { ok: true, value: result.value.result, warnings: result.warnings }
    : result;
}

async function inspectKind(
  path: string,
): Promise<DocumentFileResult<Readonly<{ mode: number }>>> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return failure("document.file-kind");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return failure("document.file-kind");
      }
      return success({ mode: after.mode & 0o777 });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["ELOOP", "EISDIR"].includes(errno(error) ?? "")) {
      return failure("document.file-kind");
    }
    if (errno(error) === "ENOENT") return failure("document.not-found");
    return failure("document.read");
  }
}

async function readVerifiedDocument(
  path: string,
): Promise<
  DocumentFileResult<Readonly<{ document: BringsDocument; mode: number }>>
> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      return failure("document.file-kind");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const after = await handle.stat();
      if (
        !after.isFile() ||
        after.nlink !== 1 ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        return failure("document.file-kind");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await handle.readFile("utf8"));
      } catch {
        return failure("document.json");
      }
      const validated = validateDocument(parsed as BringsDocumentInput);
      if (!validated.ok) {
        return {
          ok: false,
          error: validated.error,
          revision: { expected: null, actual: null },
          warnings: [],
        };
      }
      return success({ document: validated.value, mode: after.mode & 0o777 });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (["ELOOP", "EISDIR"].includes(errno(error) ?? "")) {
      return failure("document.file-kind");
    }
    if (errno(error) === "ENOENT") return failure("document.not-found");
    return failure("document.read");
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareTemporary(
  path: string,
  document: BringsDocument,
  mode: number,
  faults?: TransactionFaults,
): Promise<DocumentFileResult<string>> {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${crypto.randomUUID()}.tmp`,
  );
  let handle;
  try {
    await faults?.beforeWriteTemp?.();
    handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      mode,
    );
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.chmod(mode);
    return success(temp);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    return failure("document.write");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function publishTemporary(
  temp: string,
  path: string,
  replace: boolean,
  faults?: TransactionFaults,
): Promise<DocumentFileResult<true>> {
  try {
    await faults?.beforePublish?.();
    if (replace) {
      await rename(temp, path);
    } else {
      await link(temp, path);
      await unlink(temp);
    }
    await syncDirectory(path);
    return success(true);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (!replace && errno(error) === "EEXIST")
      return failure("document.exists");
    return failure("document.write");
  }
}

/** Read and validate one document through a no-follow regular-file handle. */
export async function inspectDocumentFile(
  path: string,
): Promise<DocumentFileResult<Readonly<{ document: BringsDocument }>>> {
  const read = await readVerifiedDocument(path);
  if (!read.ok) return read;
  return success({ document: read.value.document });
}

/** Atomically publish a new document or explicitly replace one regular file. */
export async function createDocumentFile(input: {
  path: string;
  document: BringsDocument;
  force: boolean;
  faults?: TransactionFaults;
}): Promise<DocumentFileResult<Readonly<{ document: BringsDocument }>>> {
  const validated = validateDocument(input.document);
  if (!validated.ok) {
    return {
      ok: false,
      error: validated.error,
      revision: { expected: null, actual: null },
      warnings: [],
    };
  }
  return withLock(input.path, input.faults, async () => {
    let mode = 0o644;
    if (input.force) {
      const kind = await inspectKind(input.path);
      if (!kind.ok) return kind;
      mode = kind.value.mode;
    } else {
      try {
        await stat(input.path);
        return failure("document.exists");
      } catch (error) {
        if (errno(error) !== "ENOENT") return failure("document.read");
      }
    }
    const prepared = await prepareTemporary(
      input.path,
      validated.value,
      mode,
      input.faults,
    );
    if (!prepared.ok) return prepared;
    const published = await publishTemporary(
      prepared.value,
      input.path,
      input.force,
      input.faults,
    );
    if (!published.ok) return published;
    return success({ committed: true, result: { document: validated.value } });
  });
}

/** Execute one Core command behind revision, lock, and atomic-file boundaries. */
export async function mutateDocumentFile(input: {
  path: string;
  expectedRevision: number;
  dryRun: boolean;
  execute: (
    store: BringsDocumentStore,
    before: BringsDocument,
  ) => Result<EditorSnapshot>;
  faults?: TransactionFaults;
}): Promise<
  DocumentFileResult<
    Readonly<{
      before: BringsDocument;
      after: BringsDocument;
      selection: EditorSnapshot["selection"];
      beforeRevision: number;
      afterRevision: number;
    }>
  >
> {
  return withLock(input.path, input.faults, async () => {
    const read = await readVerifiedDocument(input.path);
    if (!read.ok) return read;
    if (read.value.document.revision !== input.expectedRevision) {
      return failure(
        "document.revision-conflict",
        "/revision",
        input.expectedRevision,
        read.value.document.revision,
      );
    }
    const opened = openDocumentStore(read.value.document);
    if (!opened.ok) {
      return {
        ok: false,
        error: opened.error,
        revision: {
          expected: input.expectedRevision,
          actual: read.value.document.revision,
        },
        warnings: [],
      };
    }
    const executed = input.execute(opened.value, read.value.document);
    if (!executed.ok) {
      return {
        ok: false,
        error: executed.error,
        revision: {
          expected: input.expectedRevision,
          actual: read.value.document.revision,
        },
        warnings: [],
      };
    }
    const validated = validateDocument(executed.value.document);
    if (!validated.ok) {
      return {
        ok: false,
        error: validated.error,
        revision: {
          expected: input.expectedRevision,
          actual: read.value.document.revision,
        },
        warnings: [],
      };
    }
    const result = {
      before: read.value.document,
      after: validated.value,
      selection: executed.value.selection,
      beforeRevision: read.value.document.revision,
      afterRevision: validated.value.revision,
    };
    if (input.dryRun) return success({ committed: false, result });

    const prepared = await prepareTemporary(
      input.path,
      validated.value,
      read.value.mode,
      input.faults,
    );
    if (!prepared.ok) return prepared;
    const published = await publishTemporary(
      prepared.value,
      input.path,
      true,
      input.faults,
    );
    if (!published.ok) return published;
    return success({ committed: true, result });
  });
}
