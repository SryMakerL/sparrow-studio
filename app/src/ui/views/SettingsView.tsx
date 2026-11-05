import { useEffect, useState } from 'react';
import { cpuBudget, MAX_SOLVER_THREADS } from '../../engine/cpuBudget';
import type { Preset, TimeLimit } from '../../engine/model';
import { TIME_LIMITS, type SolverSettings, type Threads } from '../../project/model';
import { useStudio } from '../context';
import { RunBar } from '../RunBar';
import { Explanation } from './Explanation';

type Item = 'solve' | 'time' | 'search' | 'threads';

const timeLabel = (limit: TimeLimit) =>
  limit === null
    ? 'Automatic: stop when the search stalls'
    : limit < 60
      ? `Up to ${limit} seconds`
      : `Up to ${limit / 60} minute${limit > 60 ? 's' : ''}`;
const threadsLabel = (threads: Threads) => (threads === 0 ? 'Automatic' : String(threads));
const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

export function SettingsView() {
  const { project, edit } = useStudio();
  const settings = project.settings;
  const budget = cpuBudget(settings.threads);
  const threadLimit = Math.min(budget.logicalThreads, MAX_SOLVER_THREADS);
  const displayedThreads = settings.threads === 0 ? 0 : Math.min(settings.threads, threadLimit);
  const [selected, setSelected] = useState<Item | undefined>('solve');
  const update = (change: Partial<SolverSettings>) =>
    edit((current) => ({ ...current, settings: { ...current.settings, ...change } }));
  const items: { id: Item; name: string; summary: string }[] = [
    { id: 'solve', name: 'Solver', summary: 'Local: in this browser' },
    { id: 'time', name: 'Time and stopping', summary: timeLabel(settings.timeLimitSeconds) },
    {
      id: 'search',
      name: 'Search preset',
      summary: settings.preset === 'fast' ? 'Fast' : 'Standard',
    },
    { id: 'threads', name: 'Solver threads', summary: threadsLabel(settings.threads) },
  ];
  return (
    <div className="view">
      <section className="list-panel" aria-label="Optimization settings">
        <div className="list-head">
          <span className="label">Optimization</span>
        </div>
        <div className="list-scroll">
          {items.map((item) => (
            <div key={item.id}>
              <button
                className={item.id === selected ? 'row selected' : 'row'}
                aria-expanded={item.id === selected}
                onClick={() => setSelected(item.id === selected ? undefined : item.id)}
              >
                <span className="row-text">
                  <span>{item.name}</span>
                  <span className="muted">{item.summary}</span>
                </span>
              </button>
              {item.id === selected && (
                <div className="properties">
                  {item.id === 'solve' && (
                    <p className="muted">
                      Runs locally in this browser. No account or server is required.
                    </p>
                  )}
                  {item.id === 'time' && (
                    <>
                      <label className="field">
                        Stop condition
                        <select
                          value={String(settings.timeLimitSeconds)}
                          onChange={(event) =>
                            update({
                              timeLimitSeconds: (event.target.value === 'null'
                                ? null
                                : Number(event.target.value)) as TimeLimit,
                            })
                          }
                        >
                          {TIME_LIMITS.map((limit) => (
                            <option key={String(limit)} value={String(limit)}>
                              {timeLabel(limit)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {project.stock.packing === 'sheets' && (
                        <>
                          <SheetSettingInput
                            label="Sheet compression duration, seconds"
                            value={settings.sheetCompressionSeconds}
                            max={600}
                            defaultValue={10}
                            onChange={(sheetCompressionSeconds) =>
                              update({ sheetCompressionSeconds })
                            }
                          />
                          <SheetSettingInput
                            label="Consecutive insertion failures before changing sheets"
                            value={settings.sheetInsertionFailures}
                            max={100}
                            defaultValue={3}
                            onChange={(sheetInsertionFailures) =>
                              update({ sheetInsertionFailures })
                            }
                          />
                        </>
                      )}
                    </>
                  )}
                  {item.id === 'search' && (
                    <label className="field">
                      Search preset
                      <select
                        value={settings.preset}
                        onChange={(event) => update({ preset: event.target.value as Preset })}
                      >
                        <option value="standard">Standard</option>
                        <option value="fast">Fast</option>
                      </select>
                    </label>
                  )}
                  {item.id === 'threads' && (
                    <>
                      <label className="field">
                        Solver threads
                        <select
                          value={displayedThreads}
                          onChange={(event) => update({ threads: Number(event.target.value) })}
                        >
                          {Array.from({ length: threadLimit + 1 }, (_, threads) => (
                            <option key={threads} value={threads}>
                              {threadsLabel(threads)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <p className="muted">
                        CPU limits reserve one logical thread where possible. Each sheet uses{' '}
                        {budget.effectiveThreads} solver thread
                        {budget.effectiveThreads === 1 ? '' : 's'}.
                      </p>
                      {settings.threads > budget.effectiveThreads && (
                        <p className="muted">
                          Saved preference: {settings.threads} threads. At runtime this machine
                          lowers it to {budget.effectiveThreads}; the saved preference is unchanged.
                        </p>
                      )}
                      {project.stock.packing === 'sheets' && (
                        <>
                          <label className="field">
                            Concurrent sheets
                            <select
                              value={Math.min(settings.sheetConcurrency, budget.concurrencyCap)}
                              onChange={(event) =>
                                update({ sheetConcurrency: Number(event.target.value) })
                              }
                            >
                              {Array.from(
                                { length: budget.concurrencyCap },
                                (_, index) => index + 1,
                              ).map((count) => (
                                <option key={count} value={count}>
                                  {count}
                                </option>
                              ))}
                            </select>
                            <span className="muted">
                              Default: 3. The CPU budget reserves one logical thread where possible
                              and allows up to {budget.concurrencyCap} concurrent sheets at{' '}
                              {budget.effectiveThreads} solver thread
                              {budget.effectiveThreads === 1 ? '' : 's'} per sheet. A saved higher
                              concurrency is reduced only at runtime. Insertion decisions remain
                              sequential.
                            </span>
                          </label>
                        </>
                      )}
                      {!isolated && (
                        <span className="muted">This browser session runs one thread.</span>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
          <p className="muted pad">The gap and other machine settings are in the Machine tab.</p>
        </div>
        <RunBar />
      </section>
      <SettingsExplanation item={selected ?? 'solve'} />
    </div>
  );
}

function SheetSettingInput({
  label,
  value,
  max,
  defaultValue,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const number = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= max;
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={1}
        max={max}
        step={1}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const number = Number(next);
          if (next.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= max)
            onChange(number);
        }}
      />
      <span className="muted">Default: {defaultValue}. The total time limit takes priority.</span>
    </label>
  );
}

function SettingsExplanation({ item }: { item: Item }) {
  if (item === 'solve')
    return (
      <Explanation title="Local solver">
        <p>Runs sparrow on your computer, in this browser. Free, no account.</p>
        <p>Supports open-length strips, mixed rectangular sheets and DXF irregular stock.</p>
      </Explanation>
    );
  if (item === 'time')
    return (
      <Explanation title="Time and stopping">
        <p>
          Automatic keeps searching while the layout still improves, then stops. A time limit stops
          at the limit at the latest. You can stop any run yourself; the best valid layout found so
          far is kept.
        </p>
        <p className="muted">
          In sheet mode, each board compresses independently. The compression duration (default: 10
          seconds) determines when that board requests an insertion check; other boards do not wait
          for it. Insertion checks use a single front-to-back queue and draw parts from the last
          board toward the front. Only the target and current source pause for a transfer;
          unaffected boards keep compressing within the CPU budget. A successful insertion resets
          the board's failure count; the configured consecutive failure limit stops that board's
          checks. Resident sessions are retained separately from the compute concurrency limit. If
          all parts fit on one sheet, compression continues until the total deadline or manual Stop;
          in Automatic mode it continues until Stop. Every transfer is validated and committed
          atomically. The total deadline and Stop apply to all boards.
        </p>
        <p className="muted">
          Settings apply to the next run. They do not change the current solution.
        </p>
      </Explanation>
    );
  if (item === 'search')
    return (
      <Explanation title="Search preset">
        <p>
          Standard searches more thoroughly for the best final layout. Fast commits to promising
          layouts earlier: good results sooner, sometimes a longer final length.
        </p>
      </Explanation>
    );
  return (
    <Explanation title="Solver threads">
      <p>
        Automatic calculates the CPU budget from the logical processor count, reserving one thread
        where possible. Concurrent sheets share that budget: their limit is the budget divided by
        the effective solver threads per sheet, with at least one sheet allowed. Manual thread
        preferences saved on another machine are lowered at runtime when necessary, without changing
        the saved value.
      </p>
      <p className="muted">
        Several threads need a browser session with shared memory. Otherwise, sparrow runs one
        thread.
      </p>
    </Explanation>
  );
}
