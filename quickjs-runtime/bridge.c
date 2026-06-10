#include <emscripten.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"

#define ZP_MAX_REALMS 16
#define ZP_MAX_HANDLES 4096

typedef struct {
  bool active;
  int refs;
  JSValue value;
} ZPHandle;

typedef struct {
  bool active;
  JSRuntime *rt;
  JSContext *ctx;
  ZPHandle handles[ZP_MAX_HANDLES];
} ZPRealm;

static ZPRealm zp_realms[ZP_MAX_REALMS];

EM_JS(char *, zp_host_call_bridge, (int realm_id, int call_id, const char *args_json), {
  const host = Module.zpHostCall;
  if (typeof host !== 'function') return stringToNewUTF8('null');
  try {
    const result = host(realm_id, call_id, UTF8ToString(args_json));
    return stringToNewUTF8(String(result === undefined ? 'null' : result));
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err);
    return stringToNewUTF8(JSON.stringify({ __zpHostError: message }));
  }
});

static ZPRealm *zp_realm(int id) {
  if (id <= 0 || id >= ZP_MAX_REALMS) return NULL;
  if (!zp_realms[id].active) return NULL;
  return &zp_realms[id];
}

static char *zp_strdup(const char *s) {
  size_t n = strlen(s) + 1;
  char *out = malloc(n);
  if (!out) return NULL;
  memcpy(out, s, n);
  return out;
}

static char *zp_format(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);
  if (n < 0) return zp_strdup("{\"ok\":false,\"error\":\"FORMAT_FAILED\"}");
  char *out = malloc((size_t)n + 1);
  if (!out) return NULL;
  va_start(ap, fmt);
  vsnprintf(out, (size_t)n + 1, fmt, ap);
  va_end(ap);
  return out;
}

static const char *zp_type(JSContext *ctx, JSValueConst value) {
  if (JS_IsUndefined(value)) return "undefined";
  if (JS_IsNull(value)) return "null";
  if (JS_IsBool(value)) return "boolean";
  if (JS_IsNumber(value)) return "number";
  if (JS_IsString(value)) return "string";
  if (JS_IsFunction(ctx, value)) return "function";
  if (JS_IsObject(value)) return "object";
  if (JS_IsSymbol(value)) return "symbol";
  if (JS_IsBigInt(value)) return "bigint";
  return "unknown";
}

static bool zp_is_handle_value(JSContext *ctx, JSValueConst value) {
  return JS_IsObject(value) || JS_IsFunction(ctx, value);
}

static int zp_find_handle(ZPRealm *realm, JSValueConst value) {
  if (!zp_is_handle_value(realm->ctx, value)) return 0;
  for (int i = 1; i < ZP_MAX_HANDLES; i++) {
    if (realm->handles[i].active && JS_IsStrictEqual(realm->ctx, realm->handles[i].value, value)) {
      return i;
    }
  }
  return 0;
}

static int zp_add_handle(ZPRealm *realm, JSValueConst value) {
  int existing = zp_find_handle(realm, value);
  if (existing > 0) {
    realm->handles[existing].refs++;
    return existing;
  }
  for (int i = 1; i < ZP_MAX_HANDLES; i++) {
    if (!realm->handles[i].active) {
      realm->handles[i].active = true;
      realm->handles[i].refs = 1;
      realm->handles[i].value = JS_DupValue(realm->ctx, value);
      return i;
    }
  }
  return 0;
}

static JSValueConst zp_handle_value(ZPRealm *realm, int handle) {
  if (handle <= 0 || handle >= ZP_MAX_HANDLES || !realm->handles[handle].active) return JS_UNDEFINED;
  return realm->handles[handle].value;
}

static char *zp_json_of_value(JSContext *ctx, JSValueConst value) {
  JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
  if (JS_IsException(json) || JS_IsUndefined(json)) {
    JS_FreeValue(ctx, json);
    return zp_strdup("null");
  }
  const char *text = JS_ToCString(ctx, json);
  char *out = text ? zp_strdup(text) : zp_strdup("null");
  if (text) JS_FreeCString(ctx, text);
  JS_FreeValue(ctx, json);
  return out;
}

static char *zp_json_of_cstring(JSContext *ctx, const char *text) {
  JSValue value = JS_NewString(ctx, text ? text : "");
  char *json = zp_json_of_value(ctx, value);
  JS_FreeValue(ctx, value);
  return json;
}

static char *zp_json_property(JSContext *ctx, JSValueConst obj, const char *prop) {
  if (!ctx || !JS_IsObject(obj)) return zp_strdup("null");
  JSValue value = JS_GetPropertyStr(ctx, obj, prop);
  if (JS_IsException(value) || JS_IsUndefined(value) || JS_IsNull(value)) {
    JS_FreeValue(ctx, value);
    return zp_strdup("null");
  }
  char *json = zp_json_of_value(ctx, value);
  JS_FreeValue(ctx, value);
  return json;
}

static char *zp_exception_message(JSContext *ctx, JSValueConst err) {
  char *message = zp_json_property(ctx, err, "message");
  if (message && strcmp(message, "null") != 0) return message;
  free(message);
  const char *text = JS_ToCString(ctx, err);
  char *json = text ? zp_json_of_cstring(ctx, text) : zp_strdup("null");
  if (text) JS_FreeCString(ctx, text);
  return json;
}

static char *zp_error_response(JSContext *ctx, const char *code) {
  JSValue err = ctx ? JS_GetException(ctx) : JS_UNDEFINED;
  char *detail = ctx ? zp_json_of_value(ctx, err) : zp_strdup("null");
  char *name = ctx ? zp_json_property(ctx, err, "name") : zp_strdup("null");
  char *message = ctx ? zp_exception_message(ctx, err) : zp_strdup("null");
  char *stack = ctx ? zp_json_property(ctx, err, "stack") : zp_strdup("null");
  if (ctx) JS_FreeValue(ctx, err);
  char *out = zp_format(
      "{\"ok\":false,\"error\":\"%s\",\"detail\":%s,\"name\":%s,\"message\":%s,\"stack\":%s}",
      code,
      detail ? detail : "null",
      name ? name : "null",
      message ? message : "null",
      stack ? stack : "null");
  free(detail);
  free(name);
  free(message);
  free(stack);
  return out;
}

static char *zp_value_response(ZPRealm *realm, JSValueConst value) {
  const char *type = zp_type(realm->ctx, value);
  char *json = zp_json_of_value(realm->ctx, value);
  int handle = zp_is_handle_value(realm->ctx, value) ? zp_add_handle(realm, value) : 0;
  char *out = zp_format("{\"ok\":true,\"type\":\"%s\",\"handle\":%d,\"json\":%s}", type, handle, json ? json : "null");
  free(json);
  return out;
}

static char *zp_args_response(ZPRealm *realm, int argc, JSValueConst *argv) {
  size_t cap = 64;
  size_t len = 1;
  char *out = malloc(cap);
  if (!out) return NULL;
  out[0] = '[';
  for (int i = 0; i < argc; i++) {
    char *item = zp_value_response(realm, argv[i]);
    size_t item_len = strlen(item);
    size_t need = len + item_len + 3;
    if (need > cap) {
      while (need > cap) cap *= 2;
      char *next = realloc(out, cap);
      if (!next) {
        free(item);
        free(out);
        return NULL;
      }
      out = next;
    }
    if (i > 0) out[len++] = ',';
    memcpy(out + len, item, item_len);
    len += item_len;
    free(item);
  }
  out[len++] = ']';
  out[len] = 0;
  return out;
}

static int zp_realm_id_for_context(JSContext *ctx) {
  for (int i = 1; i < ZP_MAX_REALMS; i++) {
    if (zp_realms[i].active && zp_realms[i].ctx == ctx) return i;
  }
  return 0;
}

static JSValue zp_host_function(JSContext *ctx, JSValueConst this_val, int argc, JSValueConst *argv, int magic) {
  (void)this_val;
  int realm_id = zp_realm_id_for_context(ctx);
  int call_id = magic;
  if (!realm_id || !call_id) return JS_ThrowTypeError(ctx, "invalid host function data");
  ZPRealm *realm = zp_realm(realm_id);
  char *args_json = zp_args_response(realm, argc, argv);
  char *result_json = zp_host_call_bridge(realm_id, call_id, args_json ? args_json : "[]");
  free(args_json);
  if (!result_json) return JS_ThrowTypeError(ctx, "host call returned no data");
  JSValue parsed = JS_ParseJSON(ctx, result_json, strlen(result_json), "<host-call>");
  free(result_json);
  if (JS_IsException(parsed)) return parsed;
  if (JS_IsObject(parsed)) {
    JSValue host_error = JS_GetPropertyStr(ctx, parsed, "__zpHostError");
    if (!JS_IsUndefined(host_error)) {
      const char *message = JS_ToCString(ctx, host_error);
      JSValue thrown = JS_ThrowTypeError(ctx, "%s", message ? message : "host call failed");
      if (message) JS_FreeCString(ctx, message);
      JS_FreeValue(ctx, host_error);
      JS_FreeValue(ctx, parsed);
      return thrown;
    }
    JS_FreeValue(ctx, host_error);
  }
  return parsed;
}

EMSCRIPTEN_KEEPALIVE
const char *zp_qjs_version(void) {
  return JS_GetVersion();
}

EMSCRIPTEN_KEEPALIVE
int zp_qjs_create_realm(size_t memory_limit, size_t stack_size) {
  for (int i = 1; i < ZP_MAX_REALMS; i++) {
    if (zp_realms[i].active) continue;
    JSRuntime *rt = JS_NewRuntime();
    if (!rt) return 0;
    if (memory_limit > 0) JS_SetMemoryLimit(rt, memory_limit);
    if (stack_size > 0) JS_SetMaxStackSize(rt, stack_size);
    JSContext *ctx = JS_NewContext(rt);
    if (!ctx) {
      JS_FreeRuntime(rt);
      return 0;
    }
    zp_realms[i].active = true;
    zp_realms[i].rt = rt;
    zp_realms[i].ctx = ctx;
    memset(zp_realms[i].handles, 0, sizeof(zp_realms[i].handles));
    return i;
  }
  return 0;
}

EMSCRIPTEN_KEEPALIVE
void zp_qjs_destroy_realm(int realm_id) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm) return;
  for (int i = 1; i < ZP_MAX_HANDLES; i++) {
    if (realm->handles[i].active) {
      JS_FreeValue(realm->ctx, realm->handles[i].value);
      realm->handles[i].active = false;
      realm->handles[i].refs = 0;
    }
  }
  JS_FreeContext(realm->ctx);
  JS_FreeRuntime(realm->rt);
  memset(realm, 0, sizeof(*realm));
}

EMSCRIPTEN_KEEPALIVE
char *zp_qjs_eval(int realm_id, const char *source, const char *filename, int module) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm) return zp_strdup("{\"ok\":false,\"error\":\"REALM_NOT_FOUND\"}");
  int flags = module ? JS_EVAL_TYPE_MODULE : JS_EVAL_TYPE_GLOBAL;
  JSValue result = JS_Eval(realm->ctx, source ? source : "", source ? strlen(source) : 0, filename ? filename : "<eval>", flags);
  if (JS_IsException(result)) return zp_error_response(realm->ctx, "EVAL_FAILED");
  char *out = zp_value_response(realm, result);
  JS_FreeValue(realm->ctx, result);
  return out;
}

EMSCRIPTEN_KEEPALIVE
char *zp_qjs_get_prop(int realm_id, int handle, const char *prop) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm) return zp_strdup("{\"ok\":false,\"error\":\"REALM_NOT_FOUND\"}");
  JSValueConst obj = handle == 0 ? JS_GetGlobalObject(realm->ctx) : zp_handle_value(realm, handle);
  if (JS_IsUndefined(obj)) return zp_strdup("{\"ok\":false,\"error\":\"HANDLE_NOT_FOUND\"}");
  JSValue value = JS_GetPropertyStr(realm->ctx, obj, prop ? prop : "");
  if (handle == 0) JS_FreeValue(realm->ctx, (JSValue)obj);
  if (JS_IsException(value)) return zp_error_response(realm->ctx, "GET_PROP_FAILED");
  char *out = zp_value_response(realm, value);
  JS_FreeValue(realm->ctx, value);
  return out;
}

EMSCRIPTEN_KEEPALIVE
char *zp_qjs_call_function(int realm_id, int function_handle, int this_handle, const char *argv_json) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm) return zp_strdup("{\"ok\":false,\"error\":\"REALM_NOT_FOUND\"}");
  JSValueConst fn = zp_handle_value(realm, function_handle);
  if (!JS_IsFunction(realm->ctx, fn)) return zp_strdup("{\"ok\":false,\"error\":\"FUNCTION_HANDLE_NOT_FOUND\"}");
  JSValue args_array = JS_ParseJSON(realm->ctx, argv_json ? argv_json : "[]", strlen(argv_json ? argv_json : "[]"), "<call-args>");
  if (JS_IsException(args_array)) return zp_error_response(realm->ctx, "CALL_ARGS_PARSE_FAILED");
  int64_t argc64 = 0;
  if (JS_GetLength(realm->ctx, args_array, &argc64) < 0 || argc64 < 0 || argc64 > 64) {
    JS_FreeValue(realm->ctx, args_array);
    return zp_strdup("{\"ok\":false,\"error\":\"CALL_ARGS_INVALID\"}");
  }
  int argc = (int)argc64;
  JSValue argv[64];
  for (int i = 0; i < argc; i++) {
    argv[i] = JS_GetPropertyUint32(realm->ctx, args_array, (uint32_t)i);
  }
  JSValueConst this_val = this_handle > 0 ? zp_handle_value(realm, this_handle) : JS_UNDEFINED;
  JSValue result = JS_Call(realm->ctx, fn, this_val, argc, argv);
  for (int i = 0; i < argc; i++) {
    JS_FreeValue(realm->ctx, argv[i]);
  }
  JS_FreeValue(realm->ctx, args_array);
  if (JS_IsException(result)) return zp_error_response(realm->ctx, "CALL_FAILED");
  char *out = zp_value_response(realm, result);
  JS_FreeValue(realm->ctx, result);
  return out;
}

EMSCRIPTEN_KEEPALIVE
int zp_qjs_define_host_function(int realm_id, const char *name, int call_id) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm || !name || !*name || !call_id) return 0;
  JSValue fn = JS_NewCFunctionMagic(
    realm->ctx,
    zp_host_function,
    name,
    0,
    JS_CFUNC_generic_magic,
    call_id
  );
  if (JS_IsException(fn)) return 0;
  JSValue global = JS_GetGlobalObject(realm->ctx);
  int ok = JS_SetPropertyStr(realm->ctx, global, name, fn) >= 0;
  JS_FreeValue(realm->ctx, global);
  return ok ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int zp_qjs_drain_jobs(int realm_id) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm) return -1;
  int count = 0;
  JSContext *job_ctx = NULL;
  for (;;) {
    int rc = JS_ExecutePendingJob(realm->rt, &job_ctx);
    if (rc <= 0) return rc < 0 ? -1 : count;
    count++;
  }
}

EMSCRIPTEN_KEEPALIVE
int zp_qjs_release_handle(int realm_id, int handle) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm || handle <= 0 || handle >= ZP_MAX_HANDLES || !realm->handles[handle].active) return 0;
  realm->handles[handle].refs--;
  if (realm->handles[handle].refs <= 0) {
    JS_FreeValue(realm->ctx, realm->handles[handle].value);
    realm->handles[handle].active = false;
    realm->handles[handle].refs = 0;
  }
  return 1;
}

EMSCRIPTEN_KEEPALIVE
int zp_qjs_handle_refcount(int realm_id, int handle) {
  ZPRealm *realm = zp_realm(realm_id);
  if (!realm || handle <= 0 || handle >= ZP_MAX_HANDLES || !realm->handles[handle].active) return 0;
  return realm->handles[handle].refs;
}
