// CV results → hazard grid (docs/helmet/PLAN.md §4, T4.2). The grid does the fusion (log-odds per class); this
// keeps what the HUD needs next to it: when it last changed and the hazards the camera currently has in view.
import type { CvResult, Detection } from '../contracts.ts'
import { HazardGrid } from './hazardGrid.ts'

export class HazardMap {
  readonly grid = new HazardGrid()
  /** Bumped with every fused frame, so views know when to redraw. */
  version = 0
  /** Detections of the latest frame. */
  detections: Detection[] = []
  /** CV frames fused so far. */
  frames = 0

  fuse(result: CvResult): void {
    this.grid.update(result.patch, result.id, result.groundZ)
    this.detections = result.detections
    this.frames++
    this.version++
  }
}
