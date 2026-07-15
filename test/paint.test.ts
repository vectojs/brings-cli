import { describe, expect, test } from "bun:test";

import { parsePaint } from "../src/paint";

describe("parsePaint", () => {
  test("parses exact six and eight digit hexadecimal paints", () => {
    expect(parsePaint("#2e73f2ff")).toEqual({
      type: "solid",
      r: 0x2e / 255,
      g: 0x73 / 255,
      b: 0xf2 / 255,
      a: 1,
    });
    expect(parsePaint("#123456")).toEqual({
      type: "solid",
      r: 0x12 / 255,
      g: 0x34 / 255,
      b: 0x56 / 255,
      a: 1,
    });
    expect(parsePaint("none")).toBeNull();
  });

  test("rejects symbolic, short, and malformed colors", () => {
    for (const input of ["red", "#fff", "#12345g", "#123456789"]) {
      expect(() => parsePaint(input)).toThrow("argument.paint");
    }
  });
});
