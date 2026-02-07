import { createTwoFilesPatch } from "diff";
import fs from "node:fs/promises";

const SLICE_START = 0;
const SAMPLE_BYTES = 8000;
const BYTE_NUL = 0;
const NO_NULS = 0;
const INCREMENT_ONE = 1;
const DIFF_CONTEXT_LINES = 3;

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(SLICE_START, Math.min(buf.length, SAMPLE_BYTES));
  // If there are lots of NUL bytes, treat as binary.
  let nulCount = 0;
  for (const b of sample) {
    if (b === BYTE_NUL) {
      nulCount += INCREMENT_ONE;
    }
  }
  return nulCount === NO_NULS;
}

export async function diffFiles(aPath: string, bPath: string): Promise<string> {
  const [a, b] = await Promise.all([fs.readFile(aPath), fs.readFile(bPath)]);
  if (!isProbablyText(a) || !isProbablyText(b)) {
    return "(binary diff not shown)";
  }
  const aText = a.toString("utf8");
  const bText = b.toString("utf8");
  return createTwoFilesPatch(aPath, bPath, aText, bText, "", "", {
    context: DIFF_CONTEXT_LINES,
  });
}
