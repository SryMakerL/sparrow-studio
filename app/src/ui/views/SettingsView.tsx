import { useEffect, useState } from 'react';
import {
  MAX_SOLVER_THREADS,
  type Preset,
  type SheetCycleBudget,
  type TimeLimit,
} from '../../engine/model';
import {
  DEFAULT_SHEET_CYCLE_BUDGET,
  SHEET_CYCLE_BUDGET_RANGES,
} from '../../engine/sheetCycleBudget';
import { TIME_LIMITS, type SolverSettings, type Threads } from '../../project/model';
import { useStudio } from '../context';
import { RunBar } from '../RunBar';
import { Explanation } from './Explanation';

type Item = 'solve' | 'time' | 'sheet' | 'search' | 'threads';

const cycleFields: { key: keyof SheetCycleBudget; label: string }[] = [
  { key: 'localMs', label: 'Local compression time slice, ms' },
  { key: 'globalMs', label: 'Global search time slice, ms' },
  { key: 'evacuationMs', label: 'Board evacuation time slice, ms' },
  { key: 'localPercent', label: 'Local compression share of remaining time, %' },
  { key: 'globalPercent', label: 'Global search share of remaining time, %' },
  { key: 'evacuationPercent', label: 'Board evacuation share of remaining time, %' },
  { key: 'maxRounds', label: 'Maximum cycle rounds (0 = disabled)' },
  { key: 'stallRounds', label: 'Stop after rounds without improvement (0 = disabled)' },
];

const timeLabel = (limit: TimeLimit) =>
  limit === null
    ? 'Automatic: no fixed total deadline'
    : limit < 60
      ? `Up to ${limit} seconds`
      : `Up to ${limit / 60} minute${limit > 60 ? 's' : ''}`;
const threadsLabel = (threads: Threads) => (threads === 0 ? 'Automatic' : String(threads));
const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

export function SettingsView() {
  const { project, edit } = useStudio();
  const settings = project.settings;
  const [selected, setSelected] = useState<Item | undefined>('solve');
  const update = (change: Partial<SolverSettings>) =>
    edit((current) => ({ ...current, settings: { ...current.settings, ...change } }));
  const items: { id: Item; name: string; summary: string }[] = [
    { id: 'solve', name: 'Solver', summary: 'Local: in this browser' },
    { id: 'time', name: 'Time and stopping', summary: timeLabel(settings.timeLimitSeconds) },
    ...(project.stock.packing === 'sheets'
      ? [
          {
            id: 'sheet' as const,
            name: 'Sheet search budgets',
            summary: 'Time slices, shares and cycle stopping',
          },
        ]
      : []),
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
                          <p className="muted">
                            All selected boards are searched together by Sparrow on one horizontal
                            virtual board, without rotating the boards. Fixed isolation bands are
                            max(1 mm, clearance) wide.
                          </p>
                        </>
                      )}
                    </>
                  )}
                  {item.id === 'sheet' && (
                    <>
                      {cycleFields.map(({ key, label }) => (
                        <SheetSettingInput
                          key={key}
                          label={label}
                          value={settings.sheetCycleBudget[key]}
                          min={SHEET_CYCLE_BUDGET_RANGES[key].min}
                          max={SHEET_CYCLE_BUDGET_RANGES[key].max}
                          defaultValue={DEFAULT_SHEET_CYCLE_BUDGET[key]}
                          onChange={(value) =>
                            edit((current) => ({
                              ...current,
                              settings: {
                                ...current.settings,
                                sheetCycleBudget: {
                                  ...current.settings.sheetCycleBudget,
                                  [key]: value,
                                },
                              },
                            }))
                          }
                        />
                      ))}
                      <button
                        onClick={() =>
                          update({ sheetCycleBudget: { ...DEFAULT_SHEET_CYCLE_BUDGET } })
                        }
                      >
                        Restore budget defaults
                      </button>
                      <p className="muted">
                        Each stage uses its own share of the remaining total time when that stage
                        starts, capped by its time slice. Without a total deadline, stages use their
                        time slices. Local time is divided among changed boards. These percentages
                        do not need to add up to 100%. Restore budget defaults resets only these
                        eight controls.
                      </p>
                      <p className="muted">
                        Both round thresholds default to 0, disabling round-based early stopping.
                        Automatic with both thresholds at 0 can continue until you press Stop;
                        automatic completion is not guaranteed. The total time limit and manual Stop
                        take priority. Settings apply to the next run, not the current run.
                      </p>
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
                          value={settings.threads}
                          onChange={(event) =>
                            update({ threads: Number(event.target.value) as Threads })
                          }
                        >
                          {Array.from(
                            { length: MAX_SOLVER_THREADS + 1 },
                            (_, threads) => threads as Threads,
                          ).map((threads) => (
                            <option key={threads} value={threads}>
                              {threadsLabel(threads)}
                            </option>
                          ))}
                        </select>
                      </label>
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
  min = 1,
  max,
  defaultValue,
  onChange,
}: {
  label: string;
  value: number;
  min?: number;
  max: number;
  defaultValue: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const number = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(number) && number >= min && number <= max;
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const number = Number(next);
          if (next.trim() !== '' && Number.isInteger(number) && number >= min && number <= max)
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
          Automatic has no fixed total deadline. In strip mode, the search stops when improvement
          stalls. In sheet mode, Automatic with both round thresholds at 0 (the defaults) can
          continue until you press Stop; automatic completion is not guaranteed. A time limit stops
          at the limit at the latest. You can stop any run yourself; the best valid layout found so
          far is kept.
        </p>
        <p className="muted">
          In sheet mode, the selected time is the total search budget for all board combinations.
          Sheet search budgets controls stage time slices, percentages and round thresholds; there
          is no separate time limit per combination. All selected boards are joined horizontally
          without board rotation and solved together by Sparrow. Fixed isolation bands are max(1 mm,
          clearance) wide. Stock priority and capacity guide the initial selection. A failed
          combination adds boards; a successful one tries removing boards or switching stock sizes.
          Live shows the selected board count, candidate combination round, and joint search or
          joint compression stage. The total deadline and manual Stop can interrupt any stage; the
          best validated layout found so far is kept.
        </p>
        <p className="muted">
          Settings apply to the next run. They do not change the current solution.
        </p>
      </Explanation>
    );
  if (item === 'sheet')
    return (
      <Explanation title="Sheet search budgets">
        <p>
          Alternating local compression, global search and board evacuation each have a time slice
          in milliseconds and a percentage of the total time remaining when that stage starts.
          Without a total deadline, stages are scheduled using their time slices. Local time is
          divided among the changed boards. The percentages are independent, not a split of one
          shared 100%. The total time limit and manual Stop always take priority.
        </p>
        <p>
          Board-local stages use the original Sparrow warm-start exploration and compression,
          allowing temporary collisions. A layout is published only after mapping back to the real
          boards and passing validation. Actual local time remains limited by the number of changed
          boards, its stage time slice and any remaining total time.
        </p>
        <p>
          Defaults are 10000 / 10000 / 3000 ms and 60 / 60 / 25%. Both round thresholds default to
          0, disabling round-based early stopping, not the search. Automatic with both thresholds at
          0 can continue until you press Stop; automatic completion is not guaranteed. Restore
          budget defaults resets only these eight controls. Settings apply to the next run only.
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
        Automatic reserves one reported logical core and uses up to {MAX_SOLVER_THREADS} threads.
        With 8 logical cores, Automatic uses 7 threads.
      </p>
      <p className="muted">
        Several threads need a browser session with shared memory. Otherwise, sparrow runs one
        thread.
      </p>
    </Explanation>
  );
}
