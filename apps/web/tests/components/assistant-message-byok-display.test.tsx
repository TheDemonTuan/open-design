// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AssistantMessage } from '../../src/components/AssistantMessage';
import type { ChatMessage } from '../../src/types';

const message: ChatMessage = {
  id: 'direct-byok-assistant',
  role: 'assistant',
  content: 'The research answer is visible.',
  startedAt: 1_000,
  events: [{ kind: 'status', label: 'requesting' }],
};

function show(next: ChatMessage, streaming = false) {
  return render(
    <AssistantMessage
      message={next}
      streaming={streaming}
      projectId="research-project"
      conversationId="research-conversation"
      projectKind="prototype"
    />,
  );
}

afterEach(cleanup);

describe('direct BYOK response display', () => {
  it('shows persisted content when events contain only request status', () => {
    show({ ...message, runStatus: 'succeeded', endedAt: 3_000 });
    expect(screen.getByText(message.content)).toBeTruthy();
  });

  it('keeps structured text authoritative rather than duplicating accumulated content', () => {
    show({
      ...message,
      content: 'Accumulated content must not be rendered again.',
      events: [...message.events!, { kind: 'text', text: 'Authoritative event answer.' }],
      runStatus: 'succeeded',
      endedAt: 3_000,
    });
    expect(screen.getByText('Authoritative event answer.')).toBeTruthy();
    expect(screen.queryByText('Accumulated content must not be rendered again.')).toBeNull();
  });

  it('does not announce Done for a reloaded snapshot without terminal evidence', () => {
    show(message);
    expect(screen.getByText(message.content)).toBeTruthy();
    expect(screen.queryByText('Done')).toBeNull();
    expect(screen.queryByText('Working')).toBeNull();
  });

  it('does not announce Done for a persisted running snapshot after streaming disconnects', () => {
    show({ ...message, runStatus: 'running' });
    expect(screen.queryByText('Done')).toBeNull();
  });

  it('announces Done after terminal completion is persisted', () => {
    const view = show(message);
    expect(screen.queryByText('Done')).toBeNull();
    view.rerender(
      <AssistantMessage
        message={{ ...message, runStatus: 'succeeded', endedAt: 3_000 }}
        streaming={false}
        projectId="research-project"
        conversationId="research-conversation"
        projectKind="prototype"
      />,
    );
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText(message.content)).toBeTruthy();
  });
});
