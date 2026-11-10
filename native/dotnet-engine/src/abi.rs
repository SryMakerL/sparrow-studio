//! Registry handles are integers, never caller-dereferenced pointers. Removal cancels
//! the operation; in-flight calls retain an Arc until their last access completes.
use super::*;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, OnceLock};

struct State {
    events: VecDeque<Value>,
    best: Option<Value>,
    status: &'static str,
    error: Option<String>,
    sequence: u64,
}
struct Session {
    input: String,
    revision: u32,
    cancel: Cancel,
    running: AtomicBool,
    closed: AtomicBool,
    kernel: Mutex<Option<kernel::Kernel>>,
    state: Mutex<State>,
}
static SESSIONS: OnceLock<Mutex<HashMap<u64, Arc<Session>>>> = OnceLock::new();
static NEXT: AtomicU64 = AtomicU64::new(1);
fn sessions() -> &'static Mutex<HashMap<u64, Arc<Session>>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}
fn get(id: u64) -> Result<Arc<Session>, String> {
    sessions()
        .lock()
        .map_err(|_| "Session registry poisoned")?
        .get(&id)
        .cloned()
        .ok_or_else(|| "Unknown or closed session".into())
}
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) unsafe fn input(ptr: *const c_char) -> Result<String, String> {
    if ptr.is_null() {
        return Err("Input pointer is null".into());
    }
    let mut len = 0;
    while len <= MAX_JSON && unsafe { *ptr.add(len) } != 0 {
        len += 1;
    }
    if len > MAX_JSON {
        return Err("Input exceeds 10 MiB".into());
    }
    std::str::from_utf8(unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), len) })
        .map(str::to_owned)
        .map_err(|e| e.to_string())
}
fn response(f: impl FnOnce() -> Result<Value, String>) -> *mut c_char {
    let value = match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(value)) => json!({"ok":true,"result":value}),
        Ok(Err(error)) => json!({"ok":false,"error":error}),
        Err(_) => json!({"ok":false,"error":"Native solver panicked"}),
    };
    CString::new(value.to_string())
        .expect("JSON escapes NUL")
        .into_raw()
}
fn publish(session: &Session, mut event: Value) {
    let mut state = lock(&session.state);
    state.sequence += 1;
    event["sequence"] = json!(state.sequence);
    if event["type"] == "candidate" {
        let candidate = &event["result"];
        if candidate.get("sheets").is_some()
            || state.best.as_ref().is_none_or(|best| {
                candidate["placements"].as_array().map(Vec::len)
                    != best["placements"].as_array().map(Vec::len)
                    || candidate["usedLengthMm"].as_f64() <= best["usedLengthMm"].as_f64()
            })
        {
            state.best = Some(candidate.clone());
        }
    }
    if state.events.len() >= 256 {
        state.events.pop_front();
    }
    state.events.push_back(event);
}
fn begin(session: &Session) -> Result<(), String> {
    let mut state = lock(&session.state);
    if session.closed.load(Ordering::Acquire) {
        return Err("Session is closed".into());
    }
    if session
        .running
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Session is busy".into());
    }
    session.cancel.requested.store(false, Ordering::Release);
    state.status = "running";
    state.error = None;
    state.events.clear();
    Ok(())
}
fn finish(session: &Session, result: &Result<Value, String>) {
    let mut state = lock(&session.state);
    match result {
        Ok(value) => {
            state.best = Some(value.clone());
            state.status = if session.cancel.requested.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "finished"
            };
        }
        Err(error) => {
            state.error = Some(error.clone());
            state.status = if session.cancel.requested.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "error"
            };
        }
    }
    session.running.store(false, Ordering::Release);
}

/// # Safety
/// Input is readable through its NUL terminator, at most 10 MiB. Copied on entry.
/// Returns an owned JSON envelope with result.sessionId (u64); free the string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_session_create_json(
    input_utf8: *const c_char,
    revision: u32,
) -> *mut c_char {
    response(|| {
        let input = unsafe { input(input_utf8) }?;
        sheets::parse(&input)?;
        let id = NEXT
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| "Session ID space exhausted")?;
        let session = Arc::new(Session {
            input,
            revision,
            cancel: Cancel {
                requested: AtomicBool::new(false),
            },
            running: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            kernel: Mutex::new(None),
            state: Mutex::new(State {
                events: VecDeque::new(),
                best: None,
                status: "idle",
                error: None,
                sequence: 0,
            }),
        });
        lock(sessions()).insert(id, session);
        Ok(json!({"sessionId":id}))
    })
}

/// Start an asynchronous complete Job solve. Poll concurrently for progress/results.
/// Invalid/closed IDs return an error envelope. A session permits one running job.
#[unsafe(no_mangle)]
pub extern "C" fn sparrow_session_start_json(id: u64, seed: u64) -> *mut c_char {
    response(|| {
        let session = get(id)?;
        begin(&session)?;
        let worker = session.clone();
        if let Err(e) = std::thread::Builder::new()
            .name(format!("sparrow-{id}"))
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| {
                    sheets::run(
                        &worker.input,
                        seed,
                        worker.revision,
                        Some(&worker.cancel),
                        &mut |event| publish(&worker, event),
                    )
                }))
                .unwrap_or_else(|_| Err("Native solver panicked".into()));
                finish(&worker, &result);
            })
        {
            let result = Err(e.to_string());
            finish(&session, &result);
            return Err(e.to_string());
        }
        Ok(json!({"sessionId":id,"status":"running"}))
    })
}

/// # Safety
/// Request is NUL-terminated UTF-8, at most 10 MiB. Synchronous cached sheet step.
/// Poll/cancel/free may run concurrently; another step/start returns busy.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_session_step_json(
    id: u64,
    request_utf8: *const c_char,
    seed: u64,
) -> *mut c_char {
    response(|| {
        let request: Value =
            serde_json::from_str(&unsafe { input(request_utf8) }?).map_err(|e| e.to_string())?;
        let session = get(id)?;
        begin(&session)?;
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut kernel = lock(&session.kernel);
            if kernel.is_none() {
                let job = sheets::parse(&session.input)?;
                if job.settings.sheet_stocks.is_some() || job.settings.sheet_count.is_some() {
                    return Err(
                        "Sheet step requires a single-stock catalog, not an aggregate job".into(),
                    );
                }
                *kernel = Some(kernel::Kernel::new(job)?);
            }
            kernel.as_mut().unwrap().step(
                &request,
                seed,
                session.revision,
                Some(&session.cancel),
                &mut |event| publish(&session, event),
            )
        }))
        .unwrap_or_else(|_| Err("Native solver panicked".into()));
        finish(&session, &result);
        result
    })
}

/// Returns and drains queued events plus best, status, error, and sequence.
/// Queue is bounded to 256 events; best is retained independently.
#[unsafe(no_mangle)]
pub extern "C" fn sparrow_session_poll_json(id: u64) -> *mut c_char {
    response(|| {
        let session = get(id)?;
        let mut state = lock(&session.state);
        Ok(
            json!({"sessionId":id,"status":state.status,"sequence":state.sequence,"events":state.events.drain(..).collect::<Vec<_>>(),"best":state.best,"error":state.error}),
        )
    })
}

/// Idempotent cancellation, safe concurrently with every session API.
#[unsafe(no_mangle)]
pub extern "C" fn sparrow_session_cancel(id: u64) {
    let _ = catch_unwind(|| {
        if let Ok(session) = get(id) {
            let _state = lock(&session.state);
            session.cancel.requested.store(true, Ordering::Release);
        }
    });
}

/// Idempotently remove the handle and request cancellation. Does not block.
/// An in-flight worker retains its own ownership and releases it on completion.
#[unsafe(no_mangle)]
pub extern "C" fn sparrow_session_free(id: u64) {
    let _ = catch_unwind(|| {
        if let Some(session) = lock(sessions()).remove(&id) {
            let _state = lock(&session.state);
            session.closed.store(true, Ordering::Release);
            session.cancel.requested.store(true, Ordering::Release);
        }
    });
}

/// # Safety
/// Both pointers are readable NUL-terminated UTF-8, at most 10 MiB each.
/// Returns an owned JSON envelope containing independently computed Validation.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn sparrow_validate_json(
    job_utf8: *const c_char,
    result_utf8: *const c_char,
) -> *mut c_char {
    response(|| {
        let job = sheets::parse(&unsafe { input(job_utf8) }?)?;
        let result: Value =
            serde_json::from_str(&unsafe { input(result_utf8) }?).map_err(|e| e.to_string())?;
        Ok(validation::check(&job, &result))
    })
}
