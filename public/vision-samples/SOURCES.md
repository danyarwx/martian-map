# Onboard vision: test frames

Real rover images used to set and check the thresholds of the helmet camera analyzer
(`src/vision/`). Downloaded 14 Nov 2026 from the NASA Image and Video Library
(`https://images-assets.nasa.gov/image/{ID}/`). Resized to 1280 px wide where larger.

| File | NASA ID | What it shows | Credit |
|---|---|---|---|
| `storm-curiosity-sol2074.jpg` | PIA22520 (left half) | Curiosity Mastcam, 7 June 2018 (sol 2074), east-northeast rim of Gale crater as the 2018 global dust storm builds | NASA/JPL-Caltech/MSSS |
| `storm-curiosity-sol2077.jpg` | PIA22520 (right half) | Same view on 10 June 2018 (sol 2077), three days into the storm | NASA/JPL-Caltech/MSSS |
| `dusty-sky-curiosity-2018.jpg` | PIA22486 | Curiosity self-portrait during the 2018 dust storm | NASA/JPL-Caltech/MSSS |
| `dust-devils-perseverance-sol148.jpg` | PIA25290 | Perseverance Navcam, 20 July 2021 (sol 148), dust devils across Jezero crater | NASA/JPL-Caltech |
| `rocky-plain-perseverance-2023.jpg` | PIA26074 | Perseverance Navcam, 30 Aug 2023, dust devil on Thorofare Ridge behind a rocky plain | NASA/JPL-Caltech |
| `clear-perseverance-coring-2025.jpg` | PIA26572 | Perseverance, 29 April 2025, coring with a dust devil in the distance | NASA/JPL-Caltech |

PIA22520 is published as one side-by-side picture. It was cut into its two halves and the date
captions at the top were cropped off. Nothing else was changed.

The clear-day frames from `public/data/views/` (Perseverance Navcam) are used as well.

## Not data

The "simulated dust" slider on the test page paints haze over a real frame
(`src/vision/simulate.ts`). Those frames are a demonstration, not observations.

## Model

Image model: OpenAI CLIP ViT-B/32, ONNX build `Xenova/clip-vit-base-patch32` (8-bit), run in the
browser with transformers.js (`@huggingface/transformers`). Used as published, not trained by us.
