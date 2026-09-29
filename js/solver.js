// Open-path TSP: fixed start (index 0), optional fixed end (last index).
// Works on an asymmetric duration matrix. Nearest-neighbour + 2-opt + Or-opt.

export function solvePath(matrix, { hasEnd = false } = {}) {
  const n = matrix.length;
  const endIdx = hasEnd ? n - 1 : -1;
  const middle = [];
  for (let i = 1; i < n; i++) if (i !== endIdx) middle.push(i);
  if (middle.length <= 1) return middle;

  const cost = (order) => {
    let c = 0, prev = 0;
    for (const i of order) { c += matrix[prev][i]; prev = i; }
    if (hasEnd) c += matrix[prev][endIdx];
    return c;
  };

  // Nearest neighbour
  const left = new Set(middle);
  const order = [];
  let cur = 0;
  while (left.size) {
    let best = null, bd = Infinity;
    for (const j of left) if (matrix[cur][j] < bd) { bd = matrix[cur][j]; best = j; }
    order.push(best); left.delete(best); cur = best;
  }

  let best = order, bestCost = cost(order);
  let improved = true, rounds = 0;
  while (improved && rounds++ < 50) {
    improved = false;
    // 2-opt (segment reversal)
    for (let i = 0; i < best.length - 1; i++) {
      for (let k = i + 1; k < best.length; k++) {
        const cand = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const c = cost(cand);
        if (c < bestCost - 1e-6) { best = cand; bestCost = c; improved = true; }
      }
    }
    // Or-opt (move segments of 1-3)
    for (let len = 1; len <= 3; len++) {
      for (let i = 0; i + len <= best.length; i++) {
        const seg = best.slice(i, i + len);
        const rest = best.slice(0, i).concat(best.slice(i + len));
        for (let j = 0; j <= rest.length; j++) {
          if (j === i) continue;
          const cand = rest.slice(0, j).concat(seg, rest.slice(j));
          const c = cost(cand);
          if (c < bestCost - 1e-6) { best = cand; bestCost = c; improved = true; }
        }
      }
    }
  }
  return best;
}
