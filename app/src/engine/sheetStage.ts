export type SheetStage =
  | { stage: 'local'; boardIndex: number; phase?: 'Exploration' | 'Compression' }
  | { stage: 'global'; phase?: 'Exploration' | 'Compression' }
  | { stage: 'evacuation' };

export function readSheetStage(message: {
  stage?: unknown;
  boardIndex?: unknown;
  phase?: unknown;
}): SheetStage | undefined {
  const phase =
    message.phase === 'Exploration' || message.phase === 'Compression' ? message.phase : undefined;
  if (message.stage === 'local') {
    if (
      typeof message.boardIndex !== 'number' ||
      !Number.isInteger(message.boardIndex) ||
      message.boardIndex < 0
    )
      return undefined;
    return { stage: 'local', boardIndex: message.boardIndex, phase: phase ?? 'Compression' };
  }
  if (message.stage === 'global') return { stage: 'global', phase: phase ?? 'Exploration' };
  if (message.stage === 'evacuation') return { stage: 'evacuation' };
  return undefined;
}
