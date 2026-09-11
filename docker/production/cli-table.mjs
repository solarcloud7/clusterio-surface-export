import assert from "node:assert/strict";

export function readTable(output) {
  const lines = output.trim().split(/\r?\n/);
  if (!output.trim()) return [];
  const headers = lines.shift().split("|").map(s => s.trim());
  assert.ok(headers.includes("id") && headers.includes("name"), "unexpected Clusterio list header");
  return lines.filter(line => !/^[\s|+-]+$/.test(line)).map(line => {
    const values = line.split("|").map(s => s.trim());
    assert.equal(values.length, headers.length, "unexpected Clusterio list row");
    const row = Object.fromEntries(headers.map((key, index) => [key, values[index]]));
    assert.match(row.id, /^\d+$/, "invalid Clusterio list ID");
    assert.ok(Number.isSafeInteger(Number(row.id)) && row.name);
    return { ...row, id: Number(row.id) };
  });
}
