import { useEffect, useState } from 'react';
import type { Part } from '../../engine/model';
import {
  resolvedParts,
  stockSheets,
  type MachinePreset,
  type ProjectDocument,
  type Stock,
} from '../../project/model';
import { browserStore, type ProjectSummary } from '../../project/store';
import { useStudio } from '../context';
import { Dialog } from '../Dialog';
import { formatLength } from '../format';

export type ProjectImport = { parts: Part[]; stock?: Stock; machines: MachinePreset[] };
type Kind = 'parts' | 'sheets' | 'machines';

const TITLES: Record<Kind, string> = {
  parts: 'Import parts from another project',
  sheets: 'Import stock from another project',
  machines: 'Import machine presets from another project',
};

/** Copy parts, the strip or machine presets from a project saved in this browser. */
export function ImportFromProjectDialog({
  kind,
  currentId,
  onImport,
  onClose,
}: {
  kind: Kind;
  currentId: string;
  onImport: (content: ProjectImport) => void;
  onClose: () => void;
}) {
  const { unit } = useStudio();
  const [projects, setProjects] = useState<ProjectSummary[]>();
  const [source, setSource] = useState<ProjectDocument>();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  useEffect(() => {
    browserStore
      .list()
      .then((all) => setProjects(all.filter((project) => project.id !== currentId)))
      .catch((reason: Error) => setError(reason.message));
  }, [currentId]);

  async function open(id: string) {
    try {
      const stored = await browserStore.get(id);
      if (!stored) throw Error('This project no longer exists.');
      setSource(stored.document);
      const items =
        kind === 'parts'
          ? stored.document.parts.map((part) => part.id)
          : kind === 'machines'
            ? stored.document.machines.map((machine) => machine.id)
            : stored.document.stock.packing === 'sheets'
              ? stockSheets(stored.document.stock).map((sheet) => sheet.id)
              : [stored.document.stock.strip.id];
      setChosen(new Set(items));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const items: { id: string; label: string; detail: string }[] = !source
    ? []
    : kind === 'parts'
      ? source.parts.map((part) => ({ id: part.id, label: part.name, detail: `×${part.quantity}` }))
      : kind === 'machines'
        ? source.machines.map((machine) => ({
            id: machine.id,
            label: machine.name,
            detail: `gap ${formatLength(machine.gapMm, unit, 3)} ${unit}`,
          }))
        : source.stock.packing === 'sheets'
          ? stockSheets(source.stock).map((sheet) => ({
              id: sheet.id,
              label: sheet.name,
              detail: `${sheet.kind} · ${formatLength(sheet.widthMm, unit)} × ${formatLength(sheet.lengthMm, unit)} ${unit} · ×${sheet.quantity} · priority ${sheet.priority}`,
            }))
          : [
              {
                id: source.stock.strip.id,
                label: source.stock.strip.name,
                detail: `${formatLength(source.stock.strip.widthMm, unit)} ${unit} wide · open length`,
              },
            ];

  return (
    <Dialog
      title={TITLES[kind]}
      onClose={onClose}
      wide
      actions={
        <>
          {source && <button onClick={() => setSource(undefined)}>Other project</button>}
          <button onClick={onClose}>Cancel</button>
          {source && (
            <button
              className="primary"
              disabled={!chosen.size}
              onClick={() =>
                onImport({
                  parts:
                    kind === 'parts'
                      ? resolvedParts(source).filter((part) => chosen.has(part.id))
                      : [],
                  stock:
                    kind === 'sheets' && chosen.size
                      ? source.stock.packing === 'sheets'
                        ? {
                            ...source.stock,
                            sheets: stockSheets(source.stock).filter((sheet) =>
                              chosen.has(sheet.id),
                            ),
                          }
                        : source.stock
                      : undefined,
                  machines:
                    kind === 'machines'
                      ? source.machines.filter((machine) => chosen.has(machine.id))
                      : [],
                })
              }
            >
              {kind === 'sheets' ? 'Use this stock' : `Import ${chosen.size}`}
            </button>
          )}
        </>
      }
    >
      {error && <p className="field-error">{error}</p>}
      {!source && (
        <>
          <p className="muted">Choose a project saved in this browser.</p>
          {projects && !projects.length && <p>There are no other projects yet.</p>}
          <ul className="project-list">
            {projects?.map((project) => (
              <li key={project.id}>
                <button className="row" onClick={() => void open(project.id)}>
                  <span className="row-text">
                    <span>{project.name}</span>
                    <span className="muted">
                      Changed {new Date(project.updatedAt).toLocaleString()}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {source && (
        <>
          <p>
            From <strong>{source.name}</strong>
          </p>
          {kind !== 'sheets' && items.length > 1 && (
            <div className="row-actions">
              <button
                className="small"
                onClick={() => setChosen(new Set(items.map((item) => item.id)))}
              >
                Select all
              </button>
              <button className="small" onClick={() => setChosen(new Set())}>
                Select none
              </button>
            </div>
          )}
          {!items.length && <p className="muted">This project has nothing to import here.</p>}
          <ul className="check-list">
            {items.map((item) => (
              <li key={item.id}>
                <label className="choice">
                  <input
                    type="checkbox"
                    checked={chosen.has(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                  <span className="grow">{item.label}</span>
                  <span className="muted mono">{item.detail}</span>
                </label>
              </li>
            ))}
          </ul>
          {kind === 'sheets' && (
            <p className="muted">
              The stock replaces the current material dimensions, mode and available quantity.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
