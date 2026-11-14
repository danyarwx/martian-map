// Logistic regression for the sand classifier (docs/helmet/PLAN.md §5.5, T5.2), run by the eval harness.
// Pure: no DOM, no three.js. Training here uses ground-truth labels; the result is pasted into
// cv/sandWeights.ts as constants, and the CV itself never sees a label.

export interface Prf {
  n: number
  positives: number
  tp: number
  fp: number
  fn: number
  precision: number
  recall: number
  f1: number
}

/** Precision, recall and F1 of "probability > threshold" against 0/1 labels. */
export function prf(prob: ArrayLike<number>, y: ArrayLike<number>, threshold: number, pick?: (i: number) => boolean): Prf {
  let tp = 0, fp = 0, fn = 0, n = 0, positives = 0
  for (let i = 0; i < y.length; i++) {
    if (pick && !pick(i)) continue
    n++
    const said = prob[i] > threshold
    if (y[i]) {
      positives++
      if (said) tp++
      else fn++
    } else if (said) fp++
  }
  const precision = tp + fp ? tp / (tp + fp) : 0
  const recall = tp + fn ? tp / (tp + fn) : 0
  return { n, positives, tp, fp, fn, precision, recall, f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0 }
}

/** Probabilities of rows of X (n × nf, row-major) under raw weights (nf, then the bias). */
export function predict(X: ArrayLike<number>, nf: number, w: readonly number[]): Float64Array {
  const n = X.length / nf
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let z = w[nf]
    for (let k = 0; k < nf; k++) z += w[k] * X[i * nf + k]
    out[i] = 1 / (1 + Math.exp(-z))
  }
  return out
}

export interface TrainOptions {
  iterations?: number
  learningRate?: number
  /** L2 penalty on the standardised weights. */
  l2?: number
  /** Probability above which a row counts as positive; the bias is tuned for the best F1 at it. */
  threshold?: number
}

/**
 * Fit weights (nf, then the bias) on the rows `pick` selects. Features are standardised for the fit and the
 * scaling is folded back, so the result applies to raw features. Classes are weighted equally whatever their
 * share; afterwards the bias alone is shifted to the value with the best F1 at `threshold` on the same rows.
 * Deterministic: full-batch gradient descent from zero.
 */
export function trainLogistic(X: ArrayLike<number>, y: ArrayLike<number>, nf: number, pick: (i: number) => boolean, opts: TrainOptions = {}): number[] {
  const iterations = opts.iterations ?? 3000
  const lr = opts.learningRate ?? 0.3
  const l2 = opts.l2 ?? 1e-3
  const threshold = opts.threshold ?? 0.6
  const rows: number[] = []
  for (let i = 0; i < y.length; i++) if (pick(i)) rows.push(i)
  const n = rows.length
  const pos = rows.reduce((s, i) => s + (y[i] ? 1 : 0), 0)
  if (!n || !pos || pos === n) return [...new Array<number>(nf).fill(0), pos === n && n ? 10 : -10]

  const mean = new Float64Array(nf)
  const std = new Float64Array(nf)
  for (const i of rows) for (let k = 0; k < nf; k++) mean[k] += X[i * nf + k]
  for (let k = 0; k < nf; k++) mean[k] /= n
  for (const i of rows) for (let k = 0; k < nf; k++) std[k] += (X[i * nf + k] - mean[k]) ** 2
  for (let k = 0; k < nf; k++) std[k] = Math.sqrt(std[k] / n) || 1

  const Z = new Float64Array(n * nf)
  rows.forEach((i, r) => {
    for (let k = 0; k < nf; k++) Z[r * nf + k] = (X[i * nf + k] - mean[k]) / std[k]
  })
  const wPos = n / (2 * pos)
  const wNeg = n / (2 * (n - pos))
  const w = new Float64Array(nf + 1)
  const g = new Float64Array(nf + 1)
  for (let it = 0; it < iterations; it++) {
    g.fill(0)
    for (let r = 0; r < n; r++) {
      let z = w[nf]
      for (let k = 0; k < nf; k++) z += w[k] * Z[r * nf + k]
      const label = y[rows[r]] ? 1 : 0
      const e = (1 / (1 + Math.exp(-z)) - label) * (label ? wPos : wNeg)
      for (let k = 0; k < nf; k++) g[k] += e * Z[r * nf + k]
      g[nf] += e
    }
    for (let k = 0; k < nf; k++) w[k] -= lr * (g[k] / n + l2 * w[k])
    w[nf] -= (lr * g[nf]) / n
  }

  // back to raw features
  const raw = new Array<number>(nf + 1).fill(0)
  let bias = w[nf]
  for (let k = 0; k < nf; k++) {
    raw[k] = w[k] / std[k]
    bias -= (w[k] * mean[k]) / std[k]
  }
  raw[nf] = bias

  // bias with the best F1 at the threshold (ties: the smallest shift)
  const Xp = new Float64Array(n * nf)
  rows.forEach((i, r) => {
    for (let k = 0; k < nf; k++) Xp[r * nf + k] = X[i * nf + k]
  })
  const yp = rows.map((i) => (y[i] ? 1 : 0))
  let best = { shift: 0, f1: -1 }
  for (let s = -80; s <= 80; s++) {
    const shift = s * 0.05
    const f1 = prf(predict(Xp, nf, [...raw.slice(0, nf), bias + shift]), yp, threshold).f1
    if (f1 > best.f1 + 1e-12 || (Math.abs(f1 - best.f1) <= 1e-12 && Math.abs(shift) < Math.abs(best.shift))) best = { shift, f1 }
  }
  raw[nf] = bias + best.shift
  return raw
}
