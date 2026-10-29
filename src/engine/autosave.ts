// Autosave: every 5 minutes a changed project is written to
// <name>.autosave.kadr next to the saved file (Downloads when never saved).
// Paused during exports and the voice detector. Merely keeping the assistant
// panel open must not disable crash recovery for a whole editing session.
import type { Project } from '@shared/types'
import { useEditor } from '@/state/store'
import { logWarn } from './log'

/** Heavy activities flip these; autosave skips its tick while any is set. */
export const activity = {
  exporting: false,
  /** the defect detector holds the GPU for minutes */
  voiceCheck: false,
  /** Legacy panel state; an open terminal does not suspend autosave. */
  claude: false
}

const INTERVAL_MS = 5 * 60 * 1000

let lastSnapshot: Project | null = null
let lastPath: string | null = null
let saving = false

async function tick() {
  if (saving || activity.exporting || activity.voiceCheck) return
  const s = useEditor.getState()
  // Save As changes the recovery destination without changing the project.
  if (s.project === lastSnapshot && s.projectPath === lastPath) return
  const clips = s.project.tracks.reduce((n, t) => n + t.clips.length, 0)
  if (!clips && !(s.project.texts?.length)) return // nothing worth keeping
  saving = true
  try {
    const snapshot = s.project
    const path = s.projectPath
    // Zustand updates replace the project; IPC snapshots it synchronously.
    // The main process writes a separate recovery file with tmp + rename.
    await window.kadr.autosaveProject(snapshot, path)
    lastSnapshot = snapshot
    lastPath = path
  } catch (err) {
    logWarn('автосохранение', 'не удалось записать, повторю через 5 минут', err)
  } finally {
    saving = false
  }
}

export function wireAutosave() {
  setInterval(() => void tick(), INTERVAL_MS)
}

/** Run one autosave check right now (tests / manual trigger). */
export const autosaveNow = tick
