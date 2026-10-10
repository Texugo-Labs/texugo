import { installArgv, runScriptArgv } from './project.js';
import { createSandbox, type SandboxOptions } from './sandbox.js';
import type {
  Mutation,
  Pipeline,
  ProbeResult,
  ProjectInfo,
  StepResult,
} from './types.js';

export const BASELINE_ID = 'baseline';

/**
 * Derive a verification pipeline from the project's own scripts. A project with
 * neither build nor test still gets a useful probe: "does it install at all"
 * catches a surprising share of real breakage.
 */
export function defaultPipeline(project: ProjectInfo): Pipeline {
  const pm = project.packageManager;
  const steps: Pipeline['steps'] = [];

  if (project.scripts.build) {
    steps.push({ name: 'build', argv: runScriptArgv(pm, 'build') });
  }
  if (project.scripts.typecheck) {
    steps.push({ name: 'typecheck', argv: runScriptArgv(pm, 'typecheck') });
  }
  if (project.scripts.test) {
    steps.push({ name: 'test', argv: runScriptArgv(pm, 'test') });
  }

  return {
    install: { name: 'install', argv: installArgv(pm) },
    steps,
  };
}

export interface ProbeOptions extends SandboxOptions {
  pipeline?: Pipeline;
  /** Timeout for a single step. Defaults to 10 minutes. */
  stepTimeoutMs?: number;
  /** Leave the sandbox on disk so a failure can be inspected by hand. */
  keepSandbox?: boolean;
}

/** Run one mutation (or the baseline, when mutation is null) end to end. */
export async function runProbe(
  project: ProjectInfo,
  mutation: Mutation | null,
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  const pipeline = options.pipeline ?? defaultPipeline(project);
  const stepTimeoutMs = options.stepTimeoutMs ?? 10 * 60 * 1000;
  const id = mutation?.id ?? BASELINE_ID;
  const label = mutation?.label ?? 'baseline (no changes)';
  const started = Date.now();
  const steps: StepResult[] = [];

  const result = (
    status: ProbeResult['status'],
    extra: Partial<ProbeResult> = {},
  ): ProbeResult => ({
    mutationId: id,
    label,
    ...(mutation?.group ? { group: mutation.group } : {}),
    ...(mutation?.meta ? { meta: mutation.meta } : {}),
    status,
    steps,
    durationMs: Date.now() - started,
    ...extra,
  });

  let sandbox;
  try {
    sandbox = await createSandbox(project, id, options);
  } catch (err) {
    return result('errored', { error: `could not create sandbox: ${(err as Error).message}` });
  }

  try {
    // 1. Baseline install, before any mutation.
    const install = await sandbox.exec(pipeline.install.argv, {
      name: pipeline.install.name,
      timeoutMs: stepTimeoutMs,
    });
    steps.push(install);
    if (!install.ok) {
      return result('failed', { failedStep: install.name });
    }

    // 2. Apply the mutation.
    if (mutation) {
      try {
        const mutationStep = await mutation.apply(sandbox);
        if (mutationStep) {
          steps.push(mutationStep);
          if (!mutationStep.ok) {
            return result('failed', { failedStep: mutationStep.name });
          }
        }
      } catch (err) {
        return result('errored', { error: `mutation failed to apply: ${(err as Error).message}` });
      }
    }

    // 3. Verify.
    for (const step of pipeline.steps) {
      const run = await sandbox.exec(step.argv, { name: step.name, timeoutMs: stepTimeoutMs });
      steps.push(run);
      if (!run.ok && !step.optional) {
        return result('failed', { failedStep: run.name });
      }
    }

    return result('passed');
  } finally {
    if (!options.keepSandbox) {
      await sandbox.dispose().catch(() => undefined);
    }
  }
}

export interface RunProbesOptions extends ProbeOptions {
  /** How many sandboxes to run at once. Defaults to 2. */
  concurrency?: number;
  /** Called as each probe settles, for live progress output. */
  onResult?: (result: ProbeResult) => void;
  /** Called when a probe starts. */
  onStart?: (mutation: Mutation | null) => void;
}

/**
 * Run many mutations with a bounded worker pool. Results come back in the order
 * the mutations were given, regardless of the order they finished in.
 */
export async function runProbes(
  project: ProjectInfo,
  mutations: Array<Mutation | null>,
  options: RunProbesOptions = {},
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const results = new Array<ProbeResult>(mutations.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= mutations.length) return;
      const mutation = mutations[index] ?? null;
      options.onStart?.(mutation);
      const result = await runProbe(project, mutation, options);
      results[index] = result;
      options.onResult?.(result);
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, mutations.length) }, worker);
  await Promise.all(workers);
  return results;
}
