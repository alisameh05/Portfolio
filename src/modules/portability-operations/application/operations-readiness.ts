export interface OperationsReadinessProbe {
  readonly name: "configuration" | "identity" | "database";
  check(): Promise<boolean>;
}

export interface OptionalOperationsCapabilityProbe {
  readonly name: "export" | "storage" | "alert" | "measurement" | "backup";
  check(): Promise<boolean>;
}

export interface OperationsReadinessState {
  readonly ready: boolean;
  readonly degradedCapabilities: readonly OptionalOperationsCapabilityProbe["name"][];
}

/** Required sources gate readiness; optional capabilities report degradation without taking core queries offline. */
export function createOperationsReadiness(dependencies: {
  readonly required: readonly OperationsReadinessProbe[];
  readonly optional?: readonly OptionalOperationsCapabilityProbe[];
  readonly timeoutMs?: number;
}) {
  const timeoutMs = Number.isSafeInteger(dependencies.timeoutMs) && (dependencies.timeoutMs ?? 0) >= 25 &&
    (dependencies.timeoutMs ?? 0) <= 2_000 ? dependencies.timeoutMs! : 500;
  const requiredNames = new Set(dependencies.required.map((probe) => probe.name));
  const requiredContractValid = requiredNames.size === 3 && ["configuration", "identity", "database"].every((name) => requiredNames.has(name as OperationsReadinessProbe["name"]));
  const bounded = async (probe: { check(): Promise<boolean> }) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([probe.check(), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })]);
    } catch { return false; }
    finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const read = async (): Promise<OperationsReadinessState> => {
      const [required, optional] = await Promise.all([
        Promise.all(dependencies.required.map((probe) => bounded(probe))),
        Promise.all((dependencies.optional ?? []).map(async (probe) => ({ name: probe.name, ready: await bounded(probe) }))),
      ]);
      return { ready: requiredContractValid && required.every(Boolean), degradedCapabilities: optional.filter((probe) => !probe.ready).map((probe) => probe.name) };
  };
  return {
    read,
    async check(): Promise<boolean> { return (await read()).ready; },
  };
}
