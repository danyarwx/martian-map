// Weights of the sand classifier (sand.ts): one per feature in the order of SAND_FEATURES
// (lumRel, contrast, gradEnergy, coherence, redness, roughness, logRange), then the bias.
//
// WHERE THEY COME FROM: fitted on 14 Nov 2026 (UTC) by the eval harness (src/helmet/eval, page #helmet-eval) on
// rendered helmet frames, after the world's look was reworked (FIXLIST C5): 9360 patches of 40 of its 60 fixed
// poses, each labelled from the simulated world's sand mask (public/data/helmet/tiles/*_sand.png). Logistic
// regression, classes weighted equally, bias shifted to the best F1 at probability 0.6. On the 4624 patches of
// the 20 held-out poses: precision 0.93, recall 0.90, F1 0.91. Training used that ground truth; inference
// (sand.ts) uses only these eight constants, the pixels and the frame's own point cloud.
//
// WHAT THEY HAVE LEARNED: the look of sand in the SIMULATED world (world/terrainMesh.ts, the C5 look: a touch
// darker and less red than the dusty ground, smooth and without pebbles, wind ripples 0.6 m and 0.16 m apart
// drawn as surface normals). The weights of the previous look (8 % darker, painted ripples 0.22 m apart) scored
// F1 0.61 on this look, these score 0.91. They have not been tested on real photographs. When the world's look
// or the CV camera changes, run #helmet-eval again and paste the "trained in this run" weights here.
export const SAND_WEIGHTS: readonly number[] = [4.575564, 28.91802, -86.20482, 5.106681, -233.3936, 16.11978, -0.5360187, 102.5938]
