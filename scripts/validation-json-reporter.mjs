import { JsonReporter } from "vitest/reporters";
import { safeAssertionDiagnostic } from "./validation-errors.mjs";

// Vitest 3's JSON reporter prefers error.stack, which can contain only
// STACK_TRACE_ERROR for a timeout. Retain allowlisted facts from error.message
// before that conversion; never copy the message or private assertion payloads.
export default class ValidationJsonReporter extends JsonReporter {
  constructor(options = {}) { super(options); }

  async logTasks(files, coverageMap) {
    const visit = (task) => {
      if (task.type === "test" && task.result?.state === "fail") {
        const { errorCategory, durationMs } = safeAssertionDiagnostic({
          failureMessages: (task.result.errors ?? []).map((error) => error.message),
          duration: task.result.duration,
        });
        task.meta = { ...task.meta, validationFailure: {
          ...(errorCategory ? { errorCategory } : {}),
          ...(durationMs === undefined ? {} : { durationMs }),
        } };
      }
      for (const child of task.tasks ?? []) visit(child);
    };
    for (const file of files) visit(file);
    return super.logTasks(files, coverageMap);
  }
}
