// Line-level diff producing contiguous hunks, used to render each changed
// section of a file as its own reviewable red/green block.
//
// LCS-based (dynamic programming) after trimming the common prefix/suffix,
// which keeps the DP small for typical edits. Degrades to a single hunk for
// enormous changes instead of blowing memory.

"use strict";

/**
 * @typedef {Object} Hunk
 * @property {number} oldStart   line index into the old text where the hunk begins
 * @property {string[]} oldLines lines removed by the change
 * @property {number} newStart   line index into the new text where the hunk begins
 * @property {string[]} newLines lines added by the change
 */

/**
 * Diffs two texts line-by-line into maximal contiguous hunks. Adjacent
 * removed+added runs merge into one hunk; hunks are separated by at least
 * one unchanged line. Returns [] when the texts are identical.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {Hunk[]}
 */
function lineDiff(oldText, newText) {
  const o = oldText.split("\n");
  const n = newText.split("\n");

  let pre = 0;
  while (pre < o.length && pre < n.length && o[pre] === n[pre]) {
    pre++;
  }
  let oEnd = o.length;
  let nEnd = n.length;
  while (oEnd > pre && nEnd > pre && o[oEnd - 1] === n[nEnd - 1]) {
    oEnd--;
    nEnd--;
  }

  const a = o.slice(pre, oEnd);
  const b = n.slice(pre, nEnd);
  if (a.length === 0 && b.length === 0) {
    return [];
  }
  // DP table would be too big — fall back to one coarse hunk.
  if (a.length * b.length > 4_000_000) {
    return [{ oldStart: pre, oldLines: a, newStart: pre, newLines: b }];
  }

  // LCS lengths.
  const w = b.length + 1;
  const L = [];
  for (let i = 0; i <= a.length; i++) {
    L.push(new Int32Array(w));
  }
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      L[i][j] =
        a[i - 1] === b[j - 1]
          ? L[i - 1][j - 1] + 1
          : Math.max(L[i - 1][j], L[i][j - 1]);
    }
  }

  // Backtrack, grouping consecutive removed/added lines into hunks.
  const hunks = [];
  let cur = null;
  const flush = () => {
    if (cur) {
      hunks.push(cur);
      cur = null;
    }
  };
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      flush();
      i--;
      j--;
    } else if (j > 0 && (i === 0 || L[i][j - 1] >= L[i - 1][j])) {
      if (!cur) {
        cur = { oldStart: 0, oldLines: [], newStart: 0, newLines: [] };
      }
      cur.newLines.unshift(b[j - 1]);
      j--;
      cur.oldStart = i;
      cur.newStart = j;
    } else {
      if (!cur) {
        cur = { oldStart: 0, oldLines: [], newStart: 0, newLines: [] };
      }
      cur.oldLines.unshift(a[i - 1]);
      i--;
      cur.oldStart = i;
      cur.newStart = j;
    }
  }
  flush();
  hunks.reverse();
  for (const h of hunks) {
    h.oldStart += pre;
    h.newStart += pre;
  }
  return hunks;
}

module.exports = { lineDiff };
