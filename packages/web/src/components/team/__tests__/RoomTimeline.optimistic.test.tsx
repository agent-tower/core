// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, RoomMessage, TeamRun } from '@agent-tower/shared';
import { I18nProvider } from '@/lib/i18n';
import { RoomTimeline } from '../RoomTimeline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { roomMessageDetailRefetchMock } = vi.hoisted(() => ({
  roomMessageDetailRefetchMock: vi.fn(),
}));

vi.mock('@/hooks/use-app-settings', () => ({
  useAppSettings: () => ({ data: { locale: 'en' } }),
  useUpdateAppSettings: () => ({ mutate: vi.fn() }),
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
    roomMessageDetailRefetchMock.mockReset();
    roomMessageDetailRefetchMock.mockResolvedValue({ data: undefined, error: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
    expect(container.textContent).toContain('Sending...');
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

  it('marks failed sends and restores text plus uploaded attachments', async () => {
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
    await typeMessage(container, 'Please inspect');
    await submit(container);
    await flush();

    expect(getTextarea(container).value).toBe('Please inspect');
    expect(container.textContent).toContain('Send failed');
    expect(container.textContent).toContain('Network unavailable');
    expect(container.textContent).toContain('evidence.txt');
    expect(getSendButton(container).disabled).toBe(false);
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
    expect(container.textContent).toContain('Send failed');
    expect(container.textContent).toContain('evidence.txt');
    expect(getSendButton(container).disabled).toBe(false);
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
});
