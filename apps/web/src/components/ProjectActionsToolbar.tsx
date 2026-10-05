// Project-level action bar mounted between the AppChromeHeader and
// the chat-and-workspace split (#451). Hosts the project-scoped
// actions ("Finalize design package", "Download handoff ZIP").

import { FinalizeDesignButton } from './FinalizeDesignButton';
import type { DesignMdState } from '../hooks/useDesignMdState';
import type { FinalizeStatus } from '../hooks/useFinalizeProject';

export interface ProjectActionsToolbarProps {
  designMdState: Pick<DesignMdState, 'exists' | 'isStale' | 'staleReason'>;
  finalizeStatus: FinalizeStatus;
  onFinalize: () => void;
  onCancelFinalize: () => void;
  onDownloadHandoff: () => void | Promise<void>;
  downloadingHandoff: boolean;
  onContinueInCli?: () => void | Promise<void>;
  hidden?: boolean;
}

export function ProjectActionsToolbar({
  designMdState,
  finalizeStatus,
  onFinalize,
  onCancelFinalize,
  onDownloadHandoff,
  downloadingHandoff,
  hidden,
}: ProjectActionsToolbarProps) {
  if (hidden) return null;

  const canDownload =
    designMdState.exists &&
    !designMdState.isStale &&
    finalizeStatus !== 'pending' &&
    !downloadingHandoff;

  return (
    <div
      className="project-actions-toolbar"
      role="toolbar"
      aria-label="Project actions"
    >
      <FinalizeDesignButton
        designMdState={designMdState}
        status={finalizeStatus}
        onFinalize={onFinalize}
        onCancel={onCancelFinalize}
      />
      <span className="project-actions-button-group">
        <button
          type="button"
          className="project-actions-button project-actions-button-secondary"
          disabled={!canDownload}
          onClick={() => {
            if (canDownload) {
              void onDownloadHandoff();
            }
          }}
          aria-describedby={!designMdState.exists ? 'download-handoff-disabled-hint' : undefined}
        >
          {downloadingHandoff ? 'Downloading...' : 'Download handoff ZIP'}
        </button>
        {!designMdState.exists ? (
          <span
            id="download-handoff-disabled-hint"
            className="project-actions-disabled-hint"
            role="note"
          >
            Finalize the design package first.
          </span>
        ) : designMdState.isStale ? (
          <span className="project-actions-chip" role="note" aria-label="Spec staleness">
            Spec is stale — regenerate to download
          </span>
        ) : null}
      </span>
    </div>
  );
}
