#!/usr/bin/env bun
import { createDocumentStore } from "@vectojs/brings-core";

const [command, file] = process.argv.slice(2);
if (!command || !file || !["create", "inspect"].includes(command)) {
  console.error("Usage: brings <create|inspect> <document.json>");
  process.exit(2);
}

if (command === "create") {
  const documentId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const created = createDocumentStore({
    id: documentId,
    name: "Untitled",
    initialPage: { id: pageId, name: "Page 1" },
  });
  if (!created.ok)
    throw new Error(`Core rejected the new document: ${created.error.code}`);
  await Bun.write(
    file,
    `${JSON.stringify(created.value.snapshot().document, null, 2)}\n`,
  );
  console.log(JSON.stringify({ file, documentId, pageId }, null, 2));
} else {
  const document = await Bun.file(file).json();
  console.log(
    JSON.stringify(
      {
        id: document.id,
        name: document.name,
        pages: document.pages?.length ?? 0,
        nodes: document.nodes?.length ?? 0,
      },
      null,
      2,
    ),
  );
}
