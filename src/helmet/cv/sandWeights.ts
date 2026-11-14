// Weights of the sand classifier (sand.ts): one per feature in the order of SAND_FEATURES
// (lumRel, contrast, gradEnergy, coherence, redness, roughness, logRange), then the bias.
//
// WHERE THEY COME FROM: fitted on 14 Nov 2026 by the eval harness (src/helmet/eval, page #helmet-eval) on
// rendered helmet frames: 4197 patches of 40 of its 60 fixed poses, each labelled from the simulated world's
// sand mask (public/data/helmet/tiles/*_sand.png). Logistic regression, classes weighted equally, bias shifted
// to the best F1 at probability 0.6. On the 2055 patches of the 20 held-out poses: precision 0.89, recall 0.92,
// F1 0.91. Training used that ground truth; inference (sand.ts) uses only these eight constants, the pixels
// and the frame's own point cloud.
//
// WHAT THEY HAVE LEARNED: the look of sand in the SIMULATED world (world/terrainMesh.ts: a little darker and
// less red, smooth, fine ripples). The colour carries most of it: without the redness feature the held-out F1
// falls from 0.91 to 0.69. They have not been tested on real photographs. When the world's look or the CV camera
// changes, run #helmet-eval again and paste the "trained in this run" weights here.
export const SAND_WEIGHTS: readonly number[] = [3.475349, 22.18657, -42.16044, 3.030232, -390.1495, 25.53904, -0.870392, 170.3298]
