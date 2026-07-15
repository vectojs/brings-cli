import { expect, test } from "bun:test";

test("keeps the public CLI entrypoint present", () => {
  expect(
    Bun.file(new URL("../src/cli.ts", import.meta.url)).size,
  ).toBeGreaterThan(0);
});
