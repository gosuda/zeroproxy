export const COMPILER_RESULT_SCHEMA_VERSION = 1;

const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/u;
const ERROR_STAGE = new Set(["validation", "parse", "analysis", "resolve", "transform", "codegen", "policy"]);
const RECOVERABILITY = new Set(["none", "retryable"]);

function invalid(message = "Invalid compiler result") {
  throw new TypeError(message);
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nullableString(value) {
  return value === null || typeof value === "string";
}

function safeRange(value, original = false) {
  if (!record(value)) return false;
  const fields = original
    ? ["original_start", "original_end", "generated_start", "generated_end"]
    : ["start", "end"];
  return fields.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)
    && (original
      ? value.original_start <= value.original_end && value.generated_start <= value.generated_end
      : value.start <= value.end);
}

function validEdit(edit) {
  return record(edit)
    && typeof edit.kind === "string"
    && Number.isSafeInteger(edit.start)
    && Number.isSafeInteger(edit.end)
    && edit.start >= 0
    && edit.start <= edit.end
    && typeof edit.replacement === "string";
}

function validModuleSpecifier(value) {
  return record(value)
    && ["original_start", "original_end", "generated_start", "generated_end"]
      .every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0)
    && value.original_start < value.original_end
    && value.generated_start < value.generated_end
    && typeof value.specifier === "string"
    && (value.module_type === "javascript" || value.module_type === "json");
}

function validSourceMap(value) {
  return record(value)
    && value.version === 3
    && typeof value.file === "string"
    && Array.isArray(value.sources)
    && value.sources.length === 1
    && typeof value.sources[0] === "string"
    && Array.isArray(value.sourcesContent)
    && value.sourcesContent.length === 1
    && typeof value.sourcesContent[0] === "string"
    && Array.isArray(value.names)
    && typeof value.mappings === "string";
}

function validateSuccess(value) {
  if (
    !record(value)
    || value.schema_version !== COMPILER_RESULT_SCHEMA_VERSION
    || value.ok !== true
    || typeof value.code !== "string"
    || !Array.isArray(value.edits)
    || !value.edits.every(validEdit)
    || !Array.isArray(value.edit_map)
    || !value.edit_map.every((entry) => safeRange(entry, true))
    || value.edit_map.length !== value.edits.length
    || !validSourceMap(value.source_map)
    || !Array.isArray(value.module_specifiers)
    || !value.module_specifiers.every(validModuleSpecifier)
    || !nullableString(value.source_url)
    || !nullableString(value.source_mapping_url)
    || !Array.isArray(value.diagnostics)
  ) invalid();
  return value;
}

function validateFailure(value) {
  const error = value?.error;
  if (
    !record(value)
    || value.schema_version !== COMPILER_RESULT_SCHEMA_VERSION
    || value.ok !== false
    || value.code !== null
    || !Array.isArray(value.edits) || value.edits.length !== 0
    || !Array.isArray(value.edit_map) || value.edit_map.length !== 0
    || value.source_map !== null
    || !Array.isArray(value.module_specifiers) || value.module_specifiers.length !== 0
    || value.source_url !== null
    || value.source_mapping_url !== null
    || !record(error)
    || typeof error.code !== "string" || !ERROR_CODE.test(error.code)
    || typeof error.source_kind !== "string" || error.source_kind.length === 0
    || !ERROR_STAGE.has(error.stage)
    || !RECOVERABILITY.has(error.recoverability)
    || error.line !== undefined && (!Number.isSafeInteger(error.line) || error.line < 1)
    || error.column !== undefined && (!Number.isSafeInteger(error.column) || error.column < 1)
    || !Array.isArray(value.diagnostics)
  ) invalid();
  return value;
}

function parsed(encoded) {
  if (typeof encoded !== "string") invalid();
  try {
    return JSON.parse(encoded);
  } catch {
    return invalid();
  }
}

export function validateCompilerResult(value) {
  return value?.ok === true ? validateSuccess(value) : validateFailure(value);
}

export function validateDynamicCompilerResult(value) {
  if (value?.ok === false) return validateFailure(value);
  if (
    !record(value)
    || value.schema_version !== COMPILER_RESULT_SCHEMA_VERSION
    || value.ok !== true
    || !Array.isArray(value.parameters)
    || !value.parameters.every((parameter) => {
      try {
        validateSuccess(parameter);
        return true;
      } catch {
        return false;
      }
    })
    || !record(value.body)
    || !Array.isArray(value.diagnostics)
  ) invalid("Invalid dynamic compiler result");
  validateSuccess(value.body);
  return value;
}

export function decodeCompilerResult(encoded) {
  return validateCompilerResult(parsed(encoded));
}

export function decodeDynamicCompilerResult(encoded) {
  return validateDynamicCompilerResult(parsed(encoded));
}
