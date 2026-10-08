import type { RotationStrategy, RotationTrigger } from './accountAutomation';
export type RotationDiagnostics = {
  strategy: RotationStrategy;
  trigger: RotationTrigger;
  evaluatedAt: string;
  activeId?: string;
  reason: string;
  scoreMeaning: string;
  candidates: Array<{ id: string; name: string; active: boolean; rank?: number; score?: number; reason: string; fetchedAt?: string }>;
};
