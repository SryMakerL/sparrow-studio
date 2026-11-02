import { useEffect, useState } from 'react';
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
                        <SheetTimeoutInput
                          seconds={settings.sheetStagnationSeconds}
                          onChange={(sheetStagnationSeconds) => update({ sheetStagnationSeconds })}
                        />
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
                          value={settings.threads}
                          onChange={(event) =>
                            update({ threads: Number(event.target.value) as Threads })
                          }
                        >
                          {([0, 1, 2, 3] as Threads[]).map((threads) => (
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

function SheetTimeoutInput({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const [text, setText] = useState(String(seconds));
  useEffect(() => setText(String(seconds)), [seconds]);
  const value = Number(text);
  const valid = text.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= 600;
  return (
    <label className="field">
      Sheet no-improvement timeout, seconds
      <input
        type="number"
        min={1}
        max={600}
        step={1}
        value={text}
        aria-invalid={!valid}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          const number = Number(next);
          if (next.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= 600)
            onChange(number);
        }}
      />
      <span className="muted">Default: 15 seconds. The total time limit takes priority.</span>
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
          In rectangular sheet mode, the selected time is the total search budget for all sheets.
          Earlier sheets are filled and compressed first. A sheet advances only after the configured
          no-improvement timeout (default: 15 seconds) without an improvement in its used-area
          utilization. An improvement restarts that timer. After all sheets are processed,
          partitioning restarts from the first sheet. The total time limit and manual Stop take
          priority, so a short total budget may expire before later sheets are processed. The best
          validated plan prioritizes fewer unplaced parts, higher-priority stock use, fewer sheets,
          more parts on earlier sheets, then a shorter combined used length. Automatic stops after 3
          rounds without improvement.
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
        Automatic leaves one processor core free and uses up to 3 threads. More threads stop helping
        beyond that.
      </p>
      <p className="muted">
        Several threads need a browser session with shared memory. Otherwise, sparrow runs one
        thread.
      </p>
    </Explanation>
  );
}
