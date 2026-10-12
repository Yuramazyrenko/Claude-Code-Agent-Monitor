/**
 * @file Settings.refresh.test.tsx
 * @description Exercises Settings against slow system-info requests and bursts of real
 * WebSocket messages, including recovery and responses from an unmounted page.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { StrictMode } from "react";
import { Settings } from "../Settings";
import { api } from "../../lib/api";
import { eventBus } from "../../lib/eventBus";

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../lib/api", () => ({
  api: {
    pricing: {
      list: vi.fn(async () => ({ pricing: [] })),
      listCursor: vi.fn(async () => ({ pricing: [] })),
      listGpt: vi.fn(async () => ({ pricing: [] })),
      totalCost: vi.fn(async () => ({ total_cost: 0 })),
    },
    settings: {
      info,
      claudeHome: { get: vi.fn(async () => ({ claude_home: "/test/claude" })) },
      codexHome: { get: vi.fn(async () => ({ codex_home: "/test/codex" })) },
      exportData: vi.fn(() => "/api/settings/export"),
      cleanup: vi.fn(async () => ({
        abandoned: 0,
        purged_sessions: 0,
        purged_events: 0,
        purged_agents: 0,
      })),
    },
  },
}));
vi.mock("../../components/RemoteSources", () => ({ RemoteSources: () => null }));
vi.mock("../../components/ImportHistory", () => ({ ImportHistory: () => null }));
vi.mock("../../components/AlertsNotifications", () => ({ AlertsNotifications: () => null }));
vi.mock("../../components/SnapshotStorage", () => ({
  formatStorageBytes: (bytes: number) => `${bytes} B`,
  SnapshotStorage: ({ onChanged }: { onChanged: () => void }) => (
    <button onClick={onChanged}>Refresh storage</button>
  ),
}));

function fixture(path = "/test/current.db") {
  return {
    db: { path, size: 0, counts: {} },
    hooks: { installed: false, path: "/test/settings.json", hooks: {} },
    server: {
      version: "test",
      uptime: 0,
      node_version: "test",
      platform: "test",
      ws_connections: 0,
    },
  };
}

function deferred() {
  let resolve!: (value: ReturnType<typeof fixture>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<ReturnType<typeof fixture>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mount() {
  const view = render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>
  );
  await act(async () => {});
  return view;
}

function burst() {
  for (let i = 0; i < 20; i++) {
    eventBus.publish({ type: "new_event", data: { session_id: "busy-session" } } as never);
    eventBus.publish({ type: "agent_updated", data: { session_id: "busy-session" } } as never);
  }
}

function remoteCompletion() {
  eventBus.publish({ type: "remote_source.status", data: { status: "ok" } } as never);
  eventBus.publish({
    type: "import.progress",
    data: { phase: "complete", source: "remote" },
  } as never);
  eventBus.publish({ type: "remote_data.updated", data: {} } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  info.mockReset().mockResolvedValue(fixture());
  Element.prototype.scrollIntoView = vi.fn();
  const Observer = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Settings system-info refresh", () => {
  it("loads each endpoint once for the three notifications of one remote sync", async () => {
    await mount();
    const endpoints = [
      api.pricing.list,
      api.pricing.totalCost,
      api.settings.claudeHome.get,
      api.settings.codexHome.get,
      info,
    ];
    const before = endpoints.map((fn) => ({ fn, calls: vi.mocked(fn).mock.calls.length }));
    await act(async () => {
      remoteCompletion();
      await vi.advanceTimersByTimeAsync(0);
    });
    before.forEach(({ fn, calls }) => expect(fn).toHaveBeenCalledTimes(calls + 1));
  });

  it("queues one full follow-up while remote cost reading is slow", async () => {
    await mount();
    let resolveCost!: (value: { total_cost: number }) => void;
    const pendingCost = new Promise<{ total_cost: number }>((resolve) => {
      resolveCost = resolve;
    });
    const before = vi.mocked(api.pricing.totalCost).mock.calls.length;
    vi.mocked(api.pricing.totalCost).mockReturnValueOnce(pendingCost as never);
    await act(async () => {
      remoteCompletion();
      await vi.advanceTimersByTimeAsync(0);
      remoteCompletion();
      remoteCompletion();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.pricing.totalCost).toHaveBeenCalledTimes(before + 1);
    await act(async () => {
      resolveCost({ total_cost: 123 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.pricing.totalCost).toHaveBeenCalledTimes(before + 2);
  });

  it("cancels a scheduled full remote refresh when the page unmounts", async () => {
    const view = await mount();
    const before = vi.mocked(api.pricing.totalCost).mock.calls.length;
    await act(async () => {
      remoteCompletion();
      view.unmount();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.pricing.totalCost).toHaveBeenCalledTimes(before);
  });

  it("keeps a sustained hook stream on the periodic refresh cadence", async () => {
    await mount();
    expect(info).toHaveBeenCalledTimes(1);
    for (let window = 0; window < 3; window++) {
      await act(async () => {
        burst();
      });
      expect(info).toHaveBeenCalledTimes(window + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10000);
      });
      expect(info).toHaveBeenCalledTimes(window + 2);
    }
  });

  it("coalesces remote completions into one fresh read after a slow initial request", async () => {
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise).mockResolvedValue(fixture("/test/after-import.db"));
    await mount();
    await act(async () => {
      burst();
      for (let i = 0; i < 10; i++)
        eventBus.publish({ type: "remote_data.updated", data: {} } as never);
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(info).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(fixture("/test/before-import.db"));
    });
    expect(info).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("/test/after-import.db").length).toBeGreaterThan(0);
  }, 15000);

  it("drops a queued remote refresh when unmounted before the pending read settles", async () => {
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise);
    const view = await mount();
    await act(async () => {
      eventBus.publish({ type: "remote_data.updated", data: {} } as never);
      view.unmount();
      pending.resolve(fixture());
    });
    expect(info).toHaveBeenCalledTimes(1);
  });

  it("retries after a failed request instead of retaining its rejected promise", async () => {
    info.mockRejectedValueOnce(new Error("temporarily unavailable"));
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(info).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText("/test/current.db").length).toBeGreaterThan(0);
  });

  it("does not let an old response overwrite the next page instance", async () => {
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise);
    const old = await mount();
    old.unmount();
    await mount();
    await act(async () => {
      pending.resolve(fixture("/test/stale.db"));
    });
    expect(screen.queryByText("/test/stale.db")).toBeNull();
    expect(screen.getAllByText("/test/current.db").length).toBeGreaterThan(0);
  });

  it("ignores the first effect generation's response in StrictMode", async () => {
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise);
    render(
      <StrictMode>
        <MemoryRouter>
          <Settings />
        </MemoryRouter>
      </StrictMode>
    );
    await act(async () => {});
    expect(info).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(fixture("/test/stale.db"));
    });
    expect(screen.queryByText("/test/stale.db")).toBeNull();
    expect(screen.getAllByText("/test/current.db").length).toBeGreaterThan(0);
  });

  it("gets fresh info after a storage change even if an older request is pending", async () => {
    await mount();
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    fireEvent.click(screen.getByText("Refresh storage"));
    fireEvent.click(screen.getByText("Refresh storage"));
    expect(info).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(fixture());
    });
    expect(info).toHaveBeenCalledTimes(3);
    expect(api.settings.info).toBe(info);
  });

  it("refreshes after cleanup rather than reusing the pre-mutation counts", async () => {
    await mount();
    const pending = deferred();
    info.mockReturnValueOnce(pending.promise);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    fireEvent.click(screen.getByText("Run Cleanup"));
    await act(async () => {
      fireEvent.click(screen.getByText("Confirm Cleanup"));
    });
    expect(api.settings.cleanup).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve(fixture());
    });
    expect(info).toHaveBeenCalledTimes(3);
  });
});
