import { dirOf } from './paths'

/** A different file name in the same folder does not change the workspace. */
export function agentContextKey(projectId: string, projectPath: string | null): string {
  return JSON.stringify([projectId, projectPath ? dirOf(projectPath) : null])
}
