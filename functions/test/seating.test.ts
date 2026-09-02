import { describe, expect, it } from "vitest";
import { seatingSchema } from "../src/validation/schemas";
import { mapSeatingDoc } from "../src/services/seating";

const table = (n: number): (string | null)[] =>
  Array.from({ length: n }, (_, i) => `Player ${i + 1}`);

describe("seatingSchema", () => {
  it("accepts a chart with names and empty seats", () => {
    const parsed = seatingSchema.parse({
      tables: [["Mark", "Luka", null], ["David", null]],
    });
    expect(parsed.tables).toHaveLength(2);
    expect(parsed.tables[0]).toEqual(["Mark", "Luka", null]);
  });

  it("trims seat names", () => {
    expect(seatingSchema.parse({ tables: [["  Mark  "]] }).tables[0][0]).toBe("Mark");
  });

  it("requires at least one table", () => {
    expect(() => seatingSchema.parse({ tables: [] })).toThrow();
  });

  it("rejects more than 20 tables", () => {
    const tables = Array.from({ length: 21 }, () => ["A"]);
    expect(() => seatingSchema.parse({ tables })).toThrow();
  });

  it("rejects a table with more than 40 seats", () => {
    expect(() => seatingSchema.parse({ tables: [table(41)] })).toThrow();
  });

  it("accepts a full-size chart at the caps", () => {
    const tables = Array.from({ length: 20 }, () => table(40));
    expect(() => seatingSchema.parse({ tables })).not.toThrow();
  });

  it("rejects a seat name that is not a string or null", () => {
    expect(() => seatingSchema.parse({ tables: [[42]] })).toThrow();
  });

  it("rejects an over-long seat name", () => {
    expect(() => seatingSchema.parse({ tables: [["x".repeat(200)]] })).toThrow();
  });
});

describe("mapSeatingDoc", () => {
  it("returns null for a missing document", () => {
    expect(mapSeatingDoc(undefined)).toBeNull();
    expect(mapSeatingDoc(null)).toBeNull();
  });

  it("normalizes empty strings and non-strings to null (stored {seats} shape)", () => {
    const seating = mapSeatingDoc({
      tables: [{ seats: ["Mark", "", 0, "  "] }, { seats: [] }],
    });
    expect(seating?.tables[0]).toEqual(["Mark", null, null, null]);
    expect(seating?.tables[1]).toEqual([]);
  });

  it("tolerates a malformed tables field", () => {
    expect(mapSeatingDoc({ tables: "nope" })?.tables).toEqual([]);
    expect(mapSeatingDoc({ tables: [{ notSeats: 1 }] })?.tables).toEqual([[]]);
    expect(mapSeatingDoc({})?.tables).toEqual([]);
  });

  it("carries a publishedAt when present as an ISO string", () => {
    const seating = mapSeatingDoc({ tables: [], publishedAt: "2026-09-02T10:00:00.000Z" });
    expect(seating?.publishedAt).toBe("2026-09-02T10:00:00.000Z");
  });

  it("leaves publishedAt null when absent", () => {
    expect(mapSeatingDoc({ tables: [] })?.publishedAt).toBeNull();
  });
});
