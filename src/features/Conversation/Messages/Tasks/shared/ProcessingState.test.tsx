import { type TaskDetail, ThreadStatus } from '@lobechat/types';
import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_PROGRESS, PROGRESS_INCREMENT, PROGRESS_INTERVAL } from './constants';
import ProcessingState from './ProcessingState';

vi.mock('@/store/chat', () => ({
  useChatStore: (selector: (state: any) => unknown) =>
    selector({
      operations: {},
      useEnablePollingTaskStatus: () => ({ data: undefined }),
    }),
}));

const taskDetail = (startedAt?: string): TaskDetail => ({
  startedAt,
  status: ThreadStatus.Active,
  threadId: 'thread-1',
});

const intervalDelays = (spy: { mock: { calls: unknown[][]; results: { value: unknown }[] } }) =>
  spy.mock.calls.map((call) => call[1]);

describe('ProcessingState timers', () => {
  let setIntervalSpy: { mock: { calls: unknown[][]; results: { value: unknown }[] } };
  let clearIntervalSpy: { mock: { calls: unknown[][]; results: { value: unknown }[] } };

  beforeEach(() => {
    vi.useFakeTimers();
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('schedules no timer at all when the task has not started', () => {
    render(<ProcessingState messageId={'msg-1'} taskDetail={taskDetail()} />);

    // neither the 1s elapsed timer nor the 30s progress timer
    expect(intervalDelays(setIntervalSpy)).not.toContain(1000);
    expect(intervalDelays(setIntervalSpy)).not.toContain(PROGRESS_INTERVAL);
  });

  it('runs the elapsed and progress timers once the task is running', () => {
    render(
      <ProcessingState messageId={'msg-1'} taskDetail={taskDetail(new Date().toISOString())} />,
    );

    expect(intervalDelays(setIntervalSpy)).toContain(1000);
    expect(intervalDelays(setIntervalSpy)).toContain(PROGRESS_INTERVAL);
  });

  it('tears the progress timer down once the bar is pinned at MAX_PROGRESS', () => {
    // far enough in the past that the initial progress is already capped
    const startedAt = new Date(
      Date.now() - ((MAX_PROGRESS / PROGRESS_INCREMENT) * PROGRESS_INTERVAL + PROGRESS_INTERVAL),
    ).toISOString();

    render(<ProcessingState messageId={'msg-1'} taskDetail={taskDetail(startedAt)} />);

    const progressTimers = setIntervalSpy.mock.calls
      .map((call, index) => ({ delay: call[1], timer: setIntervalSpy.mock.results[index].value }))
      .filter((entry) => entry.delay === PROGRESS_INTERVAL)
      .map((entry) => entry.timer);
    const cleared = clearIntervalSpy.mock.calls.map((call) => call[0]);

    // the elapsed-time timer keeps running; the progress one is already done
    expect(intervalDelays(setIntervalSpy)).toContain(1000);
    expect(progressTimers.length).toBeGreaterThan(0);
    for (const timer of progressTimers) expect(cleared).toContain(timer);
  });

  it('clears every interval it created on unmount', () => {
    const { unmount } = render(
      <ProcessingState messageId={'msg-1'} taskDetail={taskDetail(new Date().toISOString())} />,
    );

    const created = setIntervalSpy.mock.results.map((result) => result.value);
    expect(created.length).toBeGreaterThan(0);

    unmount();

    const cleared = clearIntervalSpy.mock.calls.map((call) => call[0]);
    for (const timer of created) expect(cleared).toContain(timer);
  });
});
