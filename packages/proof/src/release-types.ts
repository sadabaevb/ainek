// The shapes of a release inspection, apart from the code that fills them (release-chain.ts) and the code that words
// them (release-lines.ts), so that neither has to import the other for a type.
import type { Checked } from './checked.ts';
import type { EngineService, ImageRef, LauncherSettings, MeasuredSetting } from './compose-file.ts';
import type { Release } from './release.ts';

export interface Provenance {
  repository: string;
  commit: string;
  ref: string;
  workflow: string;
}
export interface ImageCheck {
  image: ImageRef;
  provenance: Checked<Provenance>;
}
/** The source between two builds, from the earlier one's commit to the later one's. */
export interface SourceChange {
  /** Commits the later build has that the earlier one lacks. */
  ahead: number;
  /** Commits the earlier build has that the later one lacks: above zero, the later build is from older or diverged source. */
  behind: number;
  /** Files changed by the `ahead` commits, as GitHub's comparison lists them: it stops at 300. */
  files: number;
  url: string;
}
/** An engine behind the service. `release` is the engine's own latest release when that is not the service's. */
export type Engine = EngineService & { release?: Release };
export interface ServiceRelease {
  service: string;
  /** Every release of this service the log holds, oldest first. */
  history: Release[];
  /** The latest of them (`history.at(-1)`): what the log says serves the model. */
  release: Release;
  /** The public file at the release's commit hashes to what the enclave recorded. */
  file: Checked<{ sha256: string }>;
  /** The repository's own tag of the recorded name points at the recorded commit. */
  tag: Checked<string>;
  /** The service's image: on NEAR AI the proxy that decrypts the prompt and signs the answer. */
  proxy?: ImageCheck;
  /** The engines the service forwards to, each as its own latest release defines it; empty when the file names none this reads. */
  engines: Engine[];
  /** When the release's commit was made, by GitHub's record (for a merged pull request, the time of the merge). */
  committedAt: Checked<string>;
  /** The most recent earlier release that ran another build of the service's image, among the last few. */
  previousBuild?: { release: Release; proxy: ImageCheck; change: Checked<SourceChange> };
}
export interface ReleaseInspection {
  log: {
    actions: number;
    since: string;
    until: string;
    tcbStatus: string;
    /** The quote behind the log and the quote behind the signing key name one dstack instance id (`sameInstance`). */
    instance: Checked<string>;
  };
  /** What the measured app compose says about Compose Manager, or why it was not read. */
  launcher: Checked<LauncherSettings>;
  /**
   * The image Compose Manager says it last started as. `boot` is the image the measured compose starts it as, when it
   * names one, and whether the two are the same: when they are, the manager's image is part of the compose hash and not
   * only the log's own word.
   */
  manager?: ImageCheck & { startedAt: string; boot?: MeasuredSetting & { image: ImageRef; same: boolean } };
  /** The compose file the model's service was found in. */
  file?: string;
  services: ServiceRelease[];
  /** Why no service could be resolved, when none was. */
  unresolved?: string;
  /**
   * Set when something was left unchecked or unresolved only because GitHub or Sigstore did not answer: asking again may
   * check more. Without it the result is as good as it will get for this report.
   */
  retry?: true;
}
export interface LeadTime {
  release: Release;
  committedAt: Checked<string>;
  /** Milliseconds from the commit to its first `compose_up`; undefined when a time is missing or does not parse. */
  leadMs: number | undefined;
}

