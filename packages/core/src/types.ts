/**
 * Core vocabulary shared by every Texugo tool.
 *
 * The model is deliberately small: a *project* is detected once, a *mutation*
 * describes one hostile change to it, and a *probe* is the act of applying that
 * mutation inside a throwaway *sandbox* and recording what broke.
 *
 *   raid      -> mutation = bump a dependency to a new major
 *   venom     -> mutation = poison the install environment
 *   thickskin -> mutation = apply a candidate remediation
 */

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun';

export interface ProjectInfo {
  /** Absolute path to the project root. */
  root: string;
  name: string;
  version: string;
  packageManager: PackageManager;
  /** Lockfile basename, or null if the project has none. */
  lockfile: string | null;
  isGitRepo: boolean;
  isMonorepo: boolean;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface StepResult {
  /** Short label, e.g. "install", "build", "test". */
  name: string;
  /** The argv that was run, joined for display. */
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  ok: boolean;
}

/** One hostile change applied to a sandboxed copy of the project. */
export interface Mutation {
  /** Stable, filesystem-safe id. Used to name the sandbox and key the report. */
  id: string;
  /** Human-readable label for the report, e.g. "react 18 -> 19". */
  label: string;
  /** Optional grouping key, e.g. the dependency name, for matrix output. */
  group?: string;
  /** Strategy-specific structured data carried through to the JSON report. */
  meta?: Record<string, unknown>;
  /**
   * Mutate the sandbox. Runs after the baseline install, before the probe steps.
   * Throw to mark the probe as errored; return a StepResult to record the work.
   */
  apply(sandbox: Sandbox): Promise<StepResult | void>;
}

export interface Sandbox {
  /** Mutation id this sandbox was created for, or "baseline". */
  id: string;
  /** Absolute path to the isolated copy of the project. */
  dir: string;
  project: ProjectInfo;
  /** Run a command inside the sandbox. */
  exec(argv: string[], options?: { name?: string; timeoutMs?: number }): Promise<StepResult>;
  readPackageJson(): Promise<Record<string, unknown>>;
  writePackageJson(pkg: Record<string, unknown>): Promise<void>;
  /** Remove the sandbox from disk. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface PipelineStep {
  name: string;
  argv: string[];
  /** A failure here does not fail the probe; it is recorded and skipped. */
  optional?: boolean;
}

export interface Pipeline {
  /** Baseline install, run before the mutation is applied. */
  install: PipelineStep;
  /** Verification steps, run after the mutation is applied, in order. */
  steps: PipelineStep[];
}

export type ProbeStatus = 'passed' | 'failed' | 'errored';

export interface ProbeResult {
  /** "baseline" for the unmutated control run. */
  mutationId: string;
  label: string;
  group?: string;
  meta?: Record<string, unknown>;
  status: ProbeStatus;
  /** Name of the first step that failed, if any. */
  failedStep?: string;
  steps: StepResult[];
  durationMs: number;
  /** Set when status is "errored" — the harness itself could not run. */
  error?: string;
}
