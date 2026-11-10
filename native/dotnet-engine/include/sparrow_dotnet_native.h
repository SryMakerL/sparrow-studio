#ifndef SPARROW_DOTNET_NATIVE_H
#define SPARROW_DOTNET_NATIVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct SparrowCancel SparrowCancel;
/* Legacy ABI: token must remain live until synchronous solve and request calls end. */
SparrowCancel *sparrow_cancel_create(void);
void sparrow_cancel_request(SparrowCancel *cancel);
void sparrow_cancel_free(SparrowCancel *cancel);
char *sparrow_solve_json(const char *input_utf8, uint64_t seed, uint32_t revision, const SparrowCancel *cancel);

/* Every returned char* is Rust-owned NUL-terminated UTF-8 JSON. Release once here. */
void sparrow_string_free(char *value);

/* Returns {ok:true,result:{sessionId:u64}}. Input is copied before return. */
char *sparrow_session_create_json(const char *input_utf8, uint32_t revision);
/* Starts an owned native worker and returns immediately. */
char *sparrow_session_start_json(uint64_t session_id, uint64_t seed);
/* Synchronous cached single-sheet step; call from a worker thread. */
char *sparrow_session_step_json(uint64_t session_id, const char *request_utf8, uint64_t seed);
/* Drains up to 256 queued events; best is independently retained. */
char *sparrow_session_poll_json(uint64_t session_id);
void sparrow_session_cancel(uint64_t session_id);
/* Idempotent, nonblocking, cancels in-flight work; Arc ownership keeps it alive. */
void sparrow_session_free(uint64_t session_id);
char *sparrow_validate_json(const char *job_utf8, const char *result_utf8);

/* Session IDs are nonrecycled registry keys, never pointers. All session APIs
 * may be called concurrently. One start/step at a time per ID (otherwise busy);
 * poll drains are serialized. Free is safe with running steps/workers/polling.
 * An already-admitted operation can finish after free; new calls reject the ID.
 * Unload the DLL only after all workers/steps have exited. Free requests stop,
 * not a thread join. No callback pointers or caller buffers are retained.
 * All input pointers must be readable through NUL, up to 10 MiB per input.
 * For all char* functions, failures are {ok:false,error:string}.
 */
#ifdef __cplusplus
}
#endif
#endif
