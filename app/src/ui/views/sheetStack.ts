import type { Job, Result } from '../../engine/model';

export function sheetStack(
  sheets: { job: Job; result: Result }[],
  fallbackWidth: number,
  fallbackLength: number,
) {
  const maxWidth = Math.max(fallbackWidth, ...sheets.map((s) => s.job.settings.materialWidthMm));
  const maxLength = Math.max(
    fallbackLength,
    ...sheets.map((s) => s.job.settings.sheetLengthMm ?? s.result.usedLengthMm),
  );
  const gap = Math.max(maxWidth * 0.45, maxLength * 0.08);
  let bottom = 0;
  const positions = sheets.map((sheet, index) => {
    const width = sheet.job.settings.materialWidthMm;
    const top = index === 0 ? 0 : bottom + gap;
    const offset = top + width;
    bottom = offset;
    return { offset, width };
  });
  return {
    positions,
    extent: [
      0,
      -Math.max(bottom, maxWidth) - maxWidth * 0.15,
      maxLength * 1.05,
      maxWidth * 0.3,
    ] as [number, number, number, number],
  };
}
