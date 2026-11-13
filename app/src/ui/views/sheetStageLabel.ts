import type { Result } from '../../engine/model';
import type { SheetStage } from '../../engine/sheetStage';

export function sheetStageLabel(
  stage: SheetStage | undefined,
  phase: 'Insertion' | 'Compression',
): string {
  if (!stage) return phase === 'Insertion' ? 'Joint search' : 'Joint compression';
  if (stage.stage === 'evacuation') return 'Board evacuation';
  if (stage.stage === 'global')
    return stage.phase === 'Compression' ? 'Global compression' : 'Global exploration';
  return `Board ${stage.boardIndex + 1} · local compression${stage.phase === 'Exploration' ? ' · exploration' : ''}`;
}

export function sheetBoardNumber(
  result: Pick<Result, 'physicalBoardIndex'>,
  index: number,
): number {
  return (result.physicalBoardIndex ?? index) + 1;
}
