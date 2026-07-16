import type { SolidPaintInput } from "@vectojs/brings-core";

export class PaintArgumentError extends Error {
  readonly code = "argument.paint";

  constructor(value: string) {
    super(
      `argument.paint: expected #RRGGBB, #RRGGBBAA, or none; received ${JSON.stringify(value)}`,
    );
  }
}

/** Convert the CLI's exact hexadecimal grammar to a Core solid paint. */
export function parsePaint(value: string): SolidPaintInput | null {
  if (value === "none") return null;
  if (!/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/.test(value)) {
    throw new PaintArgumentError(value);
  }
  const hex = value.slice(1);
  return {
    type: "solid",
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}
