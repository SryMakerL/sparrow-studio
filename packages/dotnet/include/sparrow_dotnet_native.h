#ifndef SPARROW_DOTNET_NATIVE_H
#define SPARROW_DOTNET_NATIVE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

typedef struct SparrowCancel SparrowCancel;

/* UTF-8 inputs are NUL-terminated, at most 10 MiB each, and borrowed for the call.
 * Every char* response is a JSON {ok,result,error} envelope owned by Rust.
 * Release responses only with sparrow_string_free, never free/delete/CoTaskMemFree.
 * Windows x64 C ABI; session IDs are integers, not dereferenceable pointers. */
SparrowCancel* sparrow_cancel_create(void);
void sparrow_cancel_request(SparrowCancel* cancel);
/* Free only after all solve/request calls using this token have completed. */
void sparrow_cancel_free(SparrowCancel* cancel);
char* sparrow_solve_json(const char* job_utf8, uint64_t seed, uint32_t revision,
                         const SparrowCancel* cancel);
void sparrow_string_free(char* response);

/* create returns result.sessionId; start runs a whole job on a native thread.
 * A session permits one start/step at a time. Poll drains pending events.
 * Poll/cancel/free are safe concurrently with an in-flight start/step.
 * free removes the handle and requests cancellation without waiting.
 * Do not unload the DLL until in-flight operations have completed. */
char* sparrow_session_create_json(const char* job_utf8, uint32_t revision);
char* sparrow_session_start_json(uint64_t session_id, uint64_t seed);
char* sparrow_session_poll_json(uint64_t session_id);
char* sparrow_session_step_json(uint64_t session_id, const char* request_utf8, uint64_t seed);
void sparrow_session_cancel(uint64_t session_id);
void sparrow_session_free(uint64_t session_id);
char* sparrow_validate_json(const char* job_utf8, const char* result_utf8);

#ifdef __cplusplus
}
#endif
#endif
