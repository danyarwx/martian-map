# Real Perseverance stereo pair at Cheyava Falls

The helmet's real-photo test (key R, `docs/helmet/PLAN.md` §7.4) runs the helmet's stereo detector on these
two photos. They are real Navcam images, rectified so that one point on the ground sits on the same row in
both. Built by `scripts/build_real_stereo.py` (`scripts/.venv/bin/python scripts/build_real_stereo.py`).

| File | What |
|---|---|
| `left.png`, `right.png` | Rectified grayscale, 512 × 384, same intrinsics, parallel axes |
| `left_rgb.png` | The left image in colour (Navcam frames are colour), same geometry as `left.png` |
| `calib.json` | `StereoIntrinsics` (`width`, `height`, `fx`, `fy`, `cx`, `cy`, `baselineM`) plus `pose`, `source` and `check` |

## Where the photos come from

- Rover: Perseverance, sol 1210 (15–16 July 2024), 13:42 local mean solar time, site 56 drive 0: parked at
  Cheyava Falls (Bright Angel area, Neretva Vallis, Jezero crater).
- Left: `NLF_1210_0774362057_630ECM_N0560000NCAM03210_01_195J`
  (https://mars.nasa.gov/mars2020/multimedia/raw-images/NLF_1210_0774362057_630ECM_N0560000NCAM03210_01_195J)
- Right: `NRF_1210_0774362057_630ECM_N0560000NCAM03210_01_195J`
  (https://mars.nasa.gov/mars2020/multimedia/raw-images/NRF_1210_0774362057_630ECM_N0560000NCAM03210_01_195J)
- Same image timestamp, same quadrant tile (`_01`, the upper-left quarter of the frame, 1288 × 968 at half
  resolution), mast pointing azimuth 61.7°, elevation −43.4° (rover frame). The view is ground only: a pair of
  half-metre rocks in front, a rock field behind, sand ripples and the rover's wheel tracks. No rover deck.
- Feed: `https://mars.nasa.gov/rss/api/?feed=raw_images&category=mars2020&feedtype=json&sol=1210`
  (`image_files.large`, 1200 × 902 JPEG, and each tile's camera model). Credit: NASA/JPL-Caltech.
- How it was picked: the script lists every left/right quadrant pair of site 56 drive 0 with mastEl between
  −46° and −22° and ranks them by the share of pixels whose ray meets the ground 1.5–20 m away outside the
  rover's footprint. The top four score 0.93–0.94; this one was chosen by eye for its rocks (`PREFERRED`).

## Method

1. Camera models. Every tile has its own CAHVORE model (C, A, H, V, O, R, E, type 2 = fisheye, parameter 0)
   in tile pixels, in the rover frame (x forward, y right, z down).
2. Rectification after Fusiello, Trucco & Verri (2000): one new rotation for both cameras (x along the
   baseline C_R − C_L, y = mean optical axis × x, z = x × y) and one intrinsic matrix
   K = [[f, 0, cx], [0, f, cy], [0, 0, 1]]. f is the widest view that still has photo data under every output
   pixel in both images; cx, cy put the middle of the tiles in the middle of the output.
3. Resampling: for each output pixel, ray = Rᵀ K⁻¹ [u v 1]ᵀ, projected into each photo with its camera model,
   bilinear interpolation. Grayscale = 0.299 R + 0.587 G + 0.114 B.

**Deviation from the plan (CAHV only).** The plan said to use C, A, H, V and ignore O, R, E. The Navcam lens
is a fisheye-type lens (model type 2): its image radius grows with the angle from the axis, not with its
tangent. A quadrant tile reaches 49° from the axis, where the two differ by about 20 %. With CAHV only, the
rows do not line up: mean |dy| 2.12 px, max 4.1 px on 13 points (`--model cahv --dry-run`), and depths come out
up to 1.7 × too far. So the script projects with the fisheye part and the radial terms of CAHVORE
(Gennery 2006: θ = angle from O, χ = θ, μ = R0 + R1 χ² + R2 χ⁴, virtual point = (|λ|/χ) O + (1 + μ) λ) and
ignores only E, the entrance-pupil shift (its coefficients are ~1e-8 here).

## Check (all numbers from `calib.json` → `check`)

20 Shi-Tomasi corners, the strongest in each cell of a 5 × 4 grid on the left image. Each one is searched in
the right image by normalised cross-correlation (21 × 21 patch) over ±5 rows and every disparity from −5 to
220 px, with a sub-pixel parabola fit. A match is counted when its NCC is at least 0.8.

- **Row offset: mean |dy| = 0.11 px, max 0.71 px, mean dy −0.07 px over 14 counted points** (limit: 1 px).
  The 6 not counted are on smooth sand or at occluding rock edges; their dy is still under 0.7 px.
- Denser run (10 × 7 grid, 45 confident and unambiguous matches): mean |dy| 0.09 px.
- **Disparity 16–82 px (median 38 px) at 512 × 384**, so 8–41 px if the CV halves the images to 256 × 192.
- **Depth Z = f·B/d = 2.8–14.2 m (median 6.0 m)**, with f = 540.9 px and B = 0.4244 m.
- Plausibility: near the bottom of the image, the stereo depth matches where each pixel's ray meets the plane
  under the wheels (3.0 m vs 3.0 m, 3.1 vs 3.1, 3.7 vs 3.6). Further up, stereo gives up to 1.4 × more: the
  rover stands tilted by about 17° on uneven ground, and the ground falls away in this direction. In the
  forward-looking tile (`..._0774361908_..._10_195J`), the two agree within 7 % from 1.9 to 3.9 m.
- Looked at: `scripts/raw/real_stereo/side_by_side.png` (red guide rows, green matched points) and
  `anaglyph.png` (not in git). Both show the same ground, rows aligned.

| u | v | NCC | dy (px) | d (px) | Z stereo (m) | Z flat ground (m) | counted |
|---|---|---|---|---|---|---|---|
| 53 | 86 | 0.708 | +0.04 | 29.5 | 7.77 | 6.37 | no (NCC < 0.8) |
| 126 | 41 | 0.778 | +0.08 | 20.2 | 11.36 | 8.03 | no (NCC < 0.8) |
| 294 | 52 | 0.965 | +0.06 | 22.3 | 10.30 | 7.59 | yes |
| 339 | 56 | 0.958 | +0.06 | 21.8 | 10.51 | 7.44 | yes |
| 406 | 58 | 0.957 | +0.07 | 20.8 | 11.06 | 7.37 | yes |
| 114 | 182 | 0.807 | −0.02 | 48.5 | 4.73 | 4.44 | yes |
| 198 | 183 | 0.874 | −0.04 | 45.0 | 5.10 | 4.43 | yes |
| 289 | 140 | 0.968 | +0.02 | 33.0 | 6.95 | 5.14 | yes |
| 375 | 162 | 0.959 | −0.09 | 37.0 | 6.20 | 4.76 | yes |
| 387 | 146 | 0.958 | +0.07 | 36.0 | 6.37 | 5.04 | yes |
| 59 | 208 | 0.850 | −0.71 | 49.5 | 4.64 | 4.10 | yes |
| 159 | 252 | 0.956 | −0.09 | 62.2 | 3.69 | 3.64 | yes |
| 238 | 250 | 0.729 | +0.20 | 57.6 | 3.98 | 3.66 | no (NCC < 0.8) |
| 371 | 196 | 0.897 | −0.01 | 42.1 | 5.46 | 4.27 | yes |
| 431 | 201 | 0.984 | −0.10 | 42.1 | 5.45 | 4.21 | yes |
| 110 | 283 | 0.796 | −0.67 | 74.2 | 3.09 | 3.37 | no (NCC < 0.8) |
| 175 | 332 | 0.934 | −0.06 | 76.0 | 3.02 | 3.01 | yes |
| 258 | 318 | 0.853 | −0.21 | 74.8 | 3.07 | 3.11 | yes |
| 299 | 271 | 0.736 | −0.04 | 57.2 | 4.01 | 3.47 | no (NCC < 0.8) |
| 435 | 334 | 0.347 | +0.06 | 68.4 | 3.36 | 3.01 | no (NCC < 0.8) |

## Things to know when using it

- **The principal point is at the bottom-right corner** (cx 516.4, cy 387.4 in a 512 × 384 image). That is
  correct: a quadrant tile has the lens axis at one of its corners, and the rectified axis must stay at right
  angles to the baseline. Back-project with `cx`, `cy` from `calib.json`, never with width/2, height/2.
- **Pose** (`calib.json` → `pose`, from the rover attitude quaternion): the rectified left camera's axis
  points to heading 322.7°, pitch −30.4°, and the image is rolled by −11.5° (right side higher).
  `Pose` in `contracts.ts` has no roll, so a ground fit that assumes a level camera will see the ground tilted
  by about 11°; the camera stands about 1.88 m above the rover frame origin (close to the ground).
- **Disparity reaches 82 px** at full size. The helmet stereo searches 0–47 px at 256 × 192, so either halve
  the images (8–41 px) or widen the search for this view.
- Limitations: E (entrance-pupil shift) ignored; the source is the 1200 px browse JPEG (compression, 8-bit,
  contrast-stretched, not calibrated radiance); the camera models come with the raw images and are not the
  final ground-processed ones; the two exposures are 0.12 s apart (same pointing).
