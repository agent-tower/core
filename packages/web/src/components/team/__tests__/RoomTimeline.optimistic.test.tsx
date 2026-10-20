// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import { usePostRoomMessage, useRoomMessages } from '@/hooks/use-team-run';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, MessageDelivery, RoomMessage, TeamMessageDelivery, TeamRun, TeamRunTranslationOverlaySummary } from '@agent-tower/shared';
import { I18nProvider } from '@/lib/i18n';
import { RoomTimeline } from '../RoomTimeline';
import type { PostRoomMessageInput } from '@/hooks/use-team-run';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { roomMessageDetailRefetchMock, scrollToBottomMock, translationFixture } = vi.hoisted(() => ({
  translationFixture: { realDeliveries: false, overlays: [] as TeamRunTranslationOverlaySummary[], deliveries: [] as MessageDelivery[], enabled: false, loadFull: vi.fn(), isCurrent: vi.fn(() => true), retry: vi.fn() },
  roomMessageDetailRefetchMock: vi.fn(),
  scrollToBottomMock: vi.fn(() => true),
}));

vi.mock('@/hooks/use-message-deliveries', async original => {
  const actual = await original<typeof import('@/hooks/use-message-deliveries')>();
  return {
    useMessageDeliveries: (...args: Parameters<typeof actual.useMessageDeliveries>) => translationFixture.realDeliveries ? actual.useMessageDeliveries(...args) : ({ data: { pages: [{ items: translationFixture.deliveries.filter(item => (item.state === 'SENT') === (args[1] === 'sent')) }] } }),
    useDeliveryAction: (scope: string) => translationFixture.realDeliveries ? actual.useDeliveryAction(scope) : ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn(), post: vi.fn() } }));
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), connected: false }) } }));
vi.mock('../TeamRoomDeliveryStatus', () => ({ TeamRoomDeliveryStatus: () => null }));

vi.mock('@/hooks/use-team-run-translations', () => ({ useTeamRunTranslations: () => translationFixture }))
vi.mock('@/hooks/use-translation-settings', () => ({ useTranslationSettings: () => ({ data: { enabled: translationFixture.enabled, sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese' } }) }))

vi.mock('use-stick-to-bottom', async () => {
  const ReactModule = await import('react');
  return {
    useStickToBottom: () => ({
      scrollRef: ReactModule.useRef<HTMLElement | null>(null),
      contentRef: ReactModule.useRef<HTMLElement | null>(null),
      isAtBottom: true,
      scrollToBottom: scrollToBottomMock,
    }),
  };
});

vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: { locale: 'en' } }),
  useUpdateAppSettings: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ data: [], isLoading: false }),
}));

vi.mock('@/hooks/use-team-run', async (importOriginal) => {
  const ReactModule = await import('react');
  const actual = await importOriginal<typeof import('@/hooks/use-team-run')>();
  return {
    ...actual,
    useApproveWorkRequest: () => ({ mutate: vi.fn(), isPending: false }),
    useRejectWorkRequest: () => ({ mutate: vi.fn(), isPending: false }),
    useStopMemberWork: () => ({ mutate: vi.fn(), isPending: false }),
    useRoomMessageDetail: () => {
      const [data, setData] = ReactModule.useState<RoomMessage | undefined>(undefined);
      return {
        data,
        isFetching: false,
        refetch: async () => {
          const result = await roomMessageDetailRefetchMock();
          if (result.data) {
            setData(result.data as RoomMessage);
          }
          return result;
        },
      };
    },
  };
});

vi.mock('@/hooks/use-attachments', async () => {
  const ReactModule = await import('react');
  const attachments: Attachment[] = [{
    id: 'attachment-1',
    originalName: 'evidence.txt',
    mimeType: 'text/plain',
    sizeBytes: 12,
    storagePath: '/tmp/evidence.txt',
    url: '/attachments/attachment-1',
    createdAt: '2026-05-27T00:00:00.000Z',
  }];

  return {
    useAttachmentMetadata: (ids: string[]) => ({
      data: attachments.filter((attachment) => ids.includes(attachment.id)),
      isLoading: false,
    }),
    useAttachments: () => {
      const [files, setFiles] = ReactModule.useState<any[]>([]);
      const filesRef = ReactModule.useRef(files);
      filesRef.current = files;

      const addFiles = ReactModule.useCallback(async (newFiles: File[]) => {
        setFiles((current) => [
          ...current,
          ...newFiles.map((file) => ({
            tempId: `tmp-${file.name}`,
            file,
            progress: 100,
            status: 'done',
            attachment: attachments[0],
          })),
        ]);
      }, []);

      const removeFile = ReactModule.useCallback((tempId: string) => {
        setFiles((current) => current.filter((file) => file.tempId !== tempId));
      }, []);

      const clear = ReactModule.useCallback(() => setFiles([]), []);

      const restoreFiles = ReactModule.useCallback((filesToRestore: any[]) => {
        setFiles((current) => {
          const existing = new Set(current.map((file) => file.attachment?.id ?? file.tempId));
          const restored = filesToRestore.filter((file) => {
            const key = file.attachment?.id ?? file.tempId;
            if (existing.has(key)) return false;
            existing.add(key);
            return true;
          });
          return [...current, ...restored];
        });
      }, []);

      const getDoneAttachments = ReactModule.useCallback(() => (
        filesRef.current
          .filter((file) => file.status === 'done' && file.attachment)
          .map((file) => file.attachment)
      ), []);

      const buildMarkdownLinks = ReactModule.useCallback(() => getDoneAttachments()
        .map((attachment: Attachment) => `[${attachment.originalName}](${attachment.storagePath})`)
        .join('\n'), [getDoneAttachments]);

      return {
        files,
        addFiles,
        removeFile,
        clear,
        restoreFiles,
        buildMarkdownLinks,
        getDoneAttachments,
        hasFiles: files.length > 0,
        isUploading: false,
      };
    },
  };
});

const teamRun: TeamRun = {
  id: 'team-run-1',
  taskId: 'task-1',
  heartbeatTimeoutMinutes: 10,
  mode: 'AUTO',
  members: [],
  invocations: [],
};

function createRoomMessage(content: string): RoomMessage {
  return {
    id: 'message-1',
    teamRunId: teamRun.id,
    senderType: 'user',
    kind: 'chat',
    visibility: 'PUBLIC',
    content,
    mentions: [],
    workRequestIds: [],
    artifactRefs: [],
    attachmentIds: [],
    createdAt: '2026-05-27T00:00:01.000Z',
  };
}

function createSourcedTeamRun(): TeamRun {
  return {
    ...teamRun,
    members: [{
      id: 'member-1',
      teamRunId: teamRun.id,
      name: 'Builder',
      aliases: [],
      providerId: 'provider-1',
      rolePrompt: '',
      capabilities: {
        readRoom: true,
        postRoomMessage: true,
        mentionMembers: true,
        stopMemberWork: false,
        markReadyForReview: true,
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        readDiff: true,
        mergeWorkspace: false,
      },
      workspacePolicy: 'dedicated',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
      membershipStatus: 'ACTIVE',
      status: 'IDLE',
    }],
    invocations: [{
      id: 'invocation-1',
      teamRunId: teamRun.id,
      workRequestId: 'request-1',
      memberId: 'member-1',
      workspaceId: 'workspace-member-1',
      sessionId: 'session-member-1',
      status: 'COMPLETED',
      roomReplyReminderCount: 0,
    }],
  } as TeamRun;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function getTextarea(container: HTMLElement) {
  const textarea = container.querySelector('textarea');
  if (!textarea) throw new Error('textarea not found');
  return textarea;
}

function getSendButton(container: HTMLElement) {
  const button = container.querySelector('button[aria-label="Send"]');
  if (!button) throw new Error('send button not found');
  return button as HTMLButtonElement;
}

function getExpandMessageButton(container: HTMLElement) {
  const button = container.querySelector('button[aria-label="Expand full message"]');
  if (!button) throw new Error('expand message button not found');
  return button as HTMLButtonElement;
}

async function typeMessage(container: HTMLElement, value: string) {
  const textarea = getTextarea(container);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
  });
}

async function uploadFile(container: HTMLElement) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (!input) throw new Error('file input not found');
  const file = new File(['attachment'], 'evidence.txt', { type: 'text/plain' });
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
  });

  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function submit(container: HTMLElement) {
  await act(async () => {
    getSendButton(container).click();
  });
}

describe('RoomTimeline optimistic sending', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    translationFixture.realDeliveries = false; translationFixture.overlays = []; translationFixture.deliveries = []; translationFixture.enabled = false; translationFixture.loadFull.mockReset(); translationFixture.retry.mockReset(); translationFixture.isCurrent.mockReturnValue(true);
    roomMessageDetailRefetchMock.mockReset();
    roomMessageDetailRefetchMock.mockResolvedValue({ data: undefined, error: null });
    scrollToBottomMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function translation(overrides = {}) {
    const row: TeamRunTranslationOverlaySummary = { teamRunId: teamRun.id, messageId: 'message-1', sourceId: 'room-source', sourceRevision: 3, overlayRevision: 9, state: 'SUCCESS', originalTextPreview: 'Original overlay preview', translatedTextPreview: 'Translated preview', originalTextTruncated: true, translatedTextTruncated: true, targetLanguage: 'Chinese', errorCode: null, ...overrides };
    translationFixture.overlays = [row];
    return row;
  }

  it.each(['TEAM_USER', 'TEAM_INITIAL'] as const)('shows no translation indicator for %s original sends, including restored room history', async origin => {
    let delivery: TeamMessageDelivery = {
      origin: 'TEAM_USER', destination: { kind: 'TEAM_ROOM', taskId: teamRun.taskId, teamRunId: teamRun.id },
      id: 'delivery', clientSubmissionId: 'submission', channelKey: 'team-channel', sequence: 1,
      originalText: 'User original', attachmentIds: [], state: 'READY', sentMode: 'ORIGINAL', acceptedText: 'User original', actualSentText: null,
      sentAt: null, acceptedDestinationId: null, lastError: null, revision: 1, createdAt: '2026-05-27T00:00:01.000Z',
    };
    if (origin === 'TEAM_INITIAL') delivery = { ...delivery, origin };
    translationFixture.deliveries = [delivery];
    const render = (messages: RoomMessage[] = []) => root.render(<I18nProvider><RoomTimeline teamRun={teamRun} messages={messages} onSendMessage={vi.fn()} /></I18nProvider>);
    await act(async () => render());
    expect(container.textContent).not.toContain('Waiting to send');
    expect(container.textContent).not.toContain('Send original');
    expect(container.querySelector('button:has(.lucide-languages)')).toBeNull();
    delivery = { ...delivery, state: 'SENT', actualSentText: delivery.originalText, revision: 2 };
    translationFixture.deliveries = [delivery];
    const message: RoomMessage = { ...createRoomMessage(delivery.originalText), userDelivery: { operationId: delivery.id, clientSubmissionId: delivery.clientSubmissionId, revision: 2, sentMode: 'ORIGINAL', actualSentText: delivery.actualSentText, isTruncated: false } };
    await act(async () => render([message]));
    expect(container.querySelector('button:has(.lucide-languages)')).toBeNull();
    // After reload only RoomMessage.userDelivery remains; it must use the same rule.
    translationFixture.deliveries = [];
    await act(async () => { root.render(<></>); });
    await act(async () => render([message]));
    expect(container.textContent).toContain('You');
    expect(container.textContent).toContain(delivery.originalText);
    expect(container.querySelector('button:has(.lucide-languages)')).toBeNull();
    translationFixture.enabled = true;
    await act(async () => render([message]));
    expect(container.querySelector('button:has(.lucide-languages)')).toBeNull();
    message.userDelivery = { ...message.userDelivery!, sentMode: 'TRANSLATED' };
    await act(async () => render([message]));
    expect(container.querySelector('button[aria-label="Actual sent text"]')).not.toBeNull();
    translationFixture.enabled = false;
    await act(async () => render([message]));
    await act(async () => (container.querySelector('button[aria-label="Actual sent text"]') as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(delivery.actualSentText);
  });

  it('expands the displayed translation with its own loader and compares only the complete original', async () => {
    const row = translation();
    const original = '  Full original\n::agent-download{file="output/proof.txt"}\n\n';
    const translated = '  Full translation\n::agent-download{file="output/proof.txt"}\n\n';
    translationFixture.loadFull.mockResolvedValue({ ...row, originalText: original, translatedText: translated });
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    const message = { ...createRoomMessage('Different 240 character preview…'), senderType: 'agent' as const, isTruncated: true };
    await act(async () => root.render(<I18nProvider><RoomTimeline teamRun={teamRun} messages={[message]} onSendMessage={vi.fn()} /></I18nProvider>));
    await act(async () => getExpandMessageButton(container).click());
    expect(translationFixture.loadFull).toHaveBeenCalledTimes(1);
    expect(roomMessageDetailRefetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Full translation');
    expect(container.textContent).not.toContain('Full original');
    await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Full translation');
    expect(document.querySelector('[aria-label="Copy message"]')).toBeNull();
    await act(async () => (document.querySelector('[aria-label="Copy original"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenLastCalledWith(original);
    expect(scrollToBottomMock).not.toHaveBeenCalled();
  });

  it('uses independent truncation flags: long original/short translation stays short until comparison is opened', async () => {
    const row = translation({ translatedTextPreview: 'Short translated body', translatedTextTruncated: false });
    translationFixture.loadFull.mockResolvedValue({ ...row, originalText: 'Full original\n\n', translatedText: 'Short translated body' });
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    await act(async () => root.render(<I18nProvider><RoomTimeline teamRun={teamRun} messages={[{ ...createRoomMessage('Original…'), isTruncated: true, senderType: 'agent' }]} onSendMessage={vi.fn()} /></I18nProvider>));
    expect(container.textContent).not.toContain('Expand full message');
    await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[aria-label="Copy original"]') as HTMLButtonElement).click());
    expect(copy).toHaveBeenCalledWith('Full original\n\n'); expect(translationFixture.loadFull).toHaveBeenCalledTimes(1);
    await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    expect(translationFixture.loadFull).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Full original');
  });

  it('keeps readable previews after full-load failure and cannot copy a preview as complete text', async () => {
    translation(); translationFixture.loadFull.mockRejectedValue(new Error('Controlled detail error'));
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    await act(async () => root.render(<I18nProvider><RoomTimeline teamRun={teamRun} messages={[{ ...createRoomMessage('Original…'), senderType: 'agent' }]} onSendMessage={vi.fn()} /></I18nProvider>));
    await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[aria-label="Copy original"]') as HTMLButtonElement).click());
    expect(copy).not.toHaveBeenCalled(); expect(container.textContent).toContain('Translated preview');
    await act(async () => getExpandMessageButton(container).click());
    expect(container.textContent).toContain('Failed to load full message');
    expect(translationFixture.loadFull).toHaveBeenCalledTimes(3);
  });

  it('retains SUCCESS when disabled, shows NOT_REQUIRED original, and locally prevents duplicate retry', async () => {
    translation({ translatedTextTruncated: false });
    const render = () => root.render(<I18nProvider><RoomTimeline teamRun={teamRun} messages={[{ ...createRoomMessage('Original readable'), senderType: 'agent' }]} onSendMessage={vi.fn()} /></I18nProvider>);
    await act(async () => render()); expect(container.textContent).toContain('Translated preview');
    translation({ state: 'NOT_REQUIRED', translatedTextPreview: 'Do not show this as translated' });
    await act(async () => render()); expect(container.textContent).toContain('Original readable'); expect(container.querySelector('[aria-haspopup="dialog"]')).toBeNull();
    const waiting = deferred<void>(); translationFixture.retry.mockReturnValue(waiting.promise); translationFixture.enabled = true;
    translation({ state: 'FAILED', translatedTextPreview: null }); await act(async () => render()); await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click());
    const retry = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('Retry translation'))!;
    await act(async () => { retry.click(); retry.click(); }); expect(translationFixture.retry).toHaveBeenCalledTimes(1);
    await act(async () => waiting.resolve());
  });

  it.each([false, true])('submits TEAM_USER through the real hook and query refresh (compact=%s)', async compact => {
    translationFixture.realDeliveries = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const pending = deferred<import('@agent-tower/shared').MessageDeliverySubmission>();
    let delivery: Extract<TeamMessageDelivery, { origin: 'TEAM_USER' }> | undefined;
    let messages: RoomMessage[] = [];
    vi.mocked(apiClient.post).mockImplementation(() => pending.promise);
    vi.mocked(apiClient.get).mockImplementation(async (url, options) => {
      if (url === '/message-deliveries') return { items: delivery && (delivery.state === 'SENT') === (options?.params?.filter === 'sent') ? [delivery] : [], nextCursor: null };
      if (url === '/message-deliveries/delivery') return delivery;
      if (url === `/team-runs/${teamRun.id}/messages`) return messages;
      throw new Error(`Unexpected request: ${url}`);
    });
    function ConnectedRoom() {
      const send = usePostRoomMessage(teamRun.id);
      const room = useRoomMessages(teamRun.id);
      return <RoomTimeline teamRun={teamRun} compactComposer={compact} messages={room.data ?? []} onSendMessage={input => send.mutateAsync(input)} />;
    }
    const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); };
    const quiet = () => {
      for (const label of ['Waiting to send', 'Send original', 'Retry translation', 'Submitting...']) expect(container.textContent).not.toContain(label);
      expect(container.querySelector('[data-delivery-state]')).toBeNull();
    };
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ConnectedRoom /></I18nProvider></QueryClientProvider>));
      await settle(); await typeMessage(container, 'Submitted original'); await submit(container); await settle();
      expect(container.textContent).toContain('Submitted original');
      expect(container.querySelector('button[aria-busy="true"] .animate-spin')).not.toBeNull();
      quiet(); await settle(); quiet();
      const body = vi.mocked(apiClient.post).mock.calls.at(-1)![1] as { clientSubmissionId: string };
      delivery = { origin: 'TEAM_USER', destination: { kind: 'TEAM_ROOM', taskId: teamRun.taskId, teamRunId: teamRun.id },
        id: 'delivery', clientSubmissionId: body.clientSubmissionId, channelKey: 'team-channel', sequence: 1,
        originalText: 'Submitted original', attachmentIds: [], state: 'READY', sentMode: 'ORIGINAL', acceptedText: 'Submitted original', actualSentText: null,
        sentAt: null, acceptedDestinationId: null, lastError: null, revision: 1, createdAt: '2026-05-27T00:00:01.000Z' };
      await act(async () => pending.resolve({ operationId: delivery!.id, state: delivery!.state, delivery: delivery!, destination: delivery!.destination, destinationId: teamRun.id }));
      await settle(); quiet();
      expect(container.textContent).toContain('Submitted original');
      for (const state of ['DISPATCHING', 'SENT'] as const) {
        delivery = { ...delivery!, state, revision: delivery!.revision + 1 };
        if (state === 'SENT') messages = [{ ...createRoomMessage(delivery.originalText), userDelivery: { operationId: delivery.id, clientSubmissionId: delivery.clientSubmissionId, revision: delivery.revision, sentMode: 'ORIGINAL', actualSentText: delivery.originalText, isTruncated: false } }];
        await act(async () => { await Promise.all([client.invalidateQueries({ queryKey: ['message-deliveries'] }), client.invalidateQueries({ queryKey: ['team-runs'] })]); });
        await settle(); quiet();
        expect(container.textContent?.split('Submitted original')).toHaveLength(2);
      }
      expect(apiClient.post).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.render(<></>)); client.clear(); sessionStorage.clear(); vi.mocked(apiClient.post).mockClear(); vi.mocked(apiClient.get).mockClear();
    }
  });

  it('clears the composer immediately and shows a pending message while sending', async () => {
    const pending = deferred<RoomMessage>();
    const onSendMessage = vi.fn(() => pending.promise);

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[]} onSendMessage={onSendMessage} />
        </I18nProvider>,
      );
    });
    await typeMessage(container, 'Hello team');
    await submit(container);

    expect(getTextarea(container).value).toBe('');
    expect(container.textContent).toContain('Hello team');
    expect(container.textContent).not.toContain('Submitting...');
    expect(container.querySelector('button[aria-busy="true"] .animate-spin')).not.toBeNull();
    expect(onSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Hello team',
      senderType: 'user',
    }));
  });

  it('removes the pending state after a successful send when the real message is rendered', async () => {
    const message = createRoomMessage('Hello team');
    const onSendMessage = vi.fn(async () => message);

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[]} onSendMessage={onSendMessage} />
        </I18nProvider>,
      );
    });
    await typeMessage(container, 'Hello team');
    await submit(container);
    await flush();

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[message]} onSendMessage={onSendMessage} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Hello team');
    expect(container.textContent).not.toContain('Sending...');
    expect(container.textContent).not.toContain('Send failed');
  });

  it('scrolls to the latest item when a new room message arrives', async () => {
    const firstMessage = createRoomMessage('First message');
    const secondMessage = {
      ...createRoomMessage('Second message'),
      id: 'message-2',
      createdAt: '2026-05-27T00:00:02.000Z',
    };
    const requestAnimationFrameSpy = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        callback(0);
        return 0;
      });

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[firstMessage]} onSendMessage={vi.fn()} />
        </I18nProvider>,
      );
    });
    scrollToBottomMock.mockClear();

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[firstMessage, secondMessage]} onSendMessage={vi.fn()} />
        </I18nProvider>,
      );
    });

    expect(scrollToBottomMock).toHaveBeenCalledWith({ animation: 'smooth', ignoreEscapes: true });
    requestAnimationFrameSpy.mockRestore();
  });

  it('keeps an unknown submission separate from the new draft and retries its exact body', async () => {
    const onSendMessage = vi.fn<(input: PostRoomMessageInput) => Promise<void>>(async () => {
      throw new Error('Network unavailable');
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[]} onSendMessage={onSendMessage} />
        </I18nProvider>,
      );
    });
    await uploadFile(container);
    await typeMessage(container, 'Please inspect');
    await submit(container);
    await flush();

    expect(getTextarea(container).value).toBe('');
    expect(container.textContent).toContain('Acceptance unknown');
    expect(container.textContent).toContain('Network unavailable');
    expect(container.textContent).toContain('evidence.txt');
    expect(getSendButton(container).disabled).toBe(true);
    const original = structuredClone(onSendMessage.mock.calls[0]![0]);
    await typeMessage(container, 'New draft');
    const retry = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'Retry original submission')!;
    await act(async () => { retry.click(); await Promise.resolve(); });
    expect(onSendMessage.mock.calls[1]![0]).toEqual(original);
    expect(getTextarea(container).value).toBe('New draft');
    await submit(container);
    expect(onSendMessage.mock.calls[2]![0].content).toBe('New draft');
    expect(onSendMessage.mock.calls[2]![0].attachmentIds ?? []).toEqual([]);
  });

  it('keeps attachment-only failed sends retryable', async () => {
    const onSendMessage = vi.fn(async () => {
      throw new Error('Network unavailable');
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[]} onSendMessage={onSendMessage} />
        </I18nProvider>,
      );
    });
    await uploadFile(container);
    await submit(container);
    await flush();

    expect(getTextarea(container).value).toBe('');
    expect(container.textContent).toContain('Acceptance unknown');
    expect(container.textContent).toContain('evidence.txt');
    expect(getSendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain('Retry original submission');
  });

  it('loads message details for truncated RoomMessages', async () => {
    const message = {
      ...createRoomMessage('Preview text...'),
      contentPreview: 'Preview text...',
      isTruncated: true,
    } as RoomMessage;
    roomMessageDetailRefetchMock.mockResolvedValueOnce({
      data: { content: 'Full message content from detail' },
      error: null,
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[message]} onSendMessage={vi.fn()} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Preview text...');
    expect(container.textContent).toContain('Expand full message');

    await act(async () => {
      getExpandMessageButton(container).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(roomMessageDetailRefetchMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Full message content from detail');
  });

  it('does not show a full-message action for untruncated RoomMessages', async () => {
    const message = {
      ...createRoomMessage('Initial task summary'),
      contentPreview: 'Initial task summary',
      isTruncated: false,
    } as RoomMessage;

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline teamRun={teamRun} messages={[message]} onSendMessage={vi.fn()} />
        </I18nProvider>,
      );
    });

    expect(container.textContent).toContain('Initial task summary');
    expect(container.textContent).not.toContain('Expand full message');
  });

  it('opens loopback links in the workspace that produced the room message', async () => {
    const onOpenPreviewUrl = vi.fn();
    const message = {
      ...createRoomMessage('[Open preview](http://127.0.0.1:4173/dashboard)'),
      senderType: 'agent',
      senderId: 'member-1',
      senderInvocationId: 'invocation-1',
    } as RoomMessage;
    const sourcedTeamRun = createSourcedTeamRun();

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline
            teamRun={sourcedTeamRun}
            messages={[message]}
            onSendMessage={vi.fn()}
            onOpenPreviewUrl={onOpenPreviewUrl}
          />
        </I18nProvider>,
      );
    });
    await flush();

    const anchor = container.querySelector('a[href="http://127.0.0.1:4173/dashboard"]');
    expect(anchor).not.toBeNull();
    await act(async () => {
      anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(onOpenPreviewUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:4173/dashboard',
      'workspace-member-1',
    );
  });

  it('opens a visualization from the session and workspace that produced the room message', async () => {
    const onOpenVisualization = vi.fn();
    const message = {
      ...createRoomMessage('::codex-inline-vis{file="agent-tower-architecture.html"}'),
      senderType: 'agent',
      senderId: 'member-1',
      senderInvocationId: 'invocation-1',
    } as RoomMessage;
    const sourcedTeamRun = createSourcedTeamRun();

    await act(async () => {
      root.render(
        <I18nProvider>
          <RoomTimeline
            teamRun={sourcedTeamRun}
            messages={[message]}
            onSendMessage={vi.fn()}
            onOpenVisualization={onOpenVisualization}
          />
        </I18nProvider>,
      );
    });

    const button = container.querySelector<HTMLButtonElement>('button[title="Open visualization"]');
    expect(button?.textContent).toContain('agent-tower-architecture.html');
    await act(async () => {
      button?.click();
    });

    expect(onOpenVisualization).toHaveBeenCalledWith(
      'session-member-1',
      'agent-tower-architecture.html',
      'workspace-member-1',
    );
  });
});
