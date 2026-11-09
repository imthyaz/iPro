import { useSyncExternalStore } from 'react';
import type { BulkApproveResult } from '@ipro/shared';
import { api, errorMessage, queryClient } from '../../api.js';

/**
 * Approvals wait 10 seconds before they are sent, so a tap or swipe can be undone (CLAUDE.md:
 * reversible actions get an undo window; decision #86). The queue lives outside React so it keeps
 * running when the inbox is left, and is sent at once if the page is closed or hidden.
 */
export const UNDO_SECONDS = 10;

export interface PendingBatch {
  id: string;
  approvalIds: string[];
  titles: Record<string, string>;
  /** What the undo bar says, e.g. "Approved: Leave for Anbu" or "Approved 10 requests". */
  label: string;
  /** Whether every item is routine, so the batch can go to the bulk endpoint. */
  routine: boolean;
  sendsAt: number;
}

export interface FailedApproval {
  approvalId: string;
  title: string;
  message: string;
}

interface State {
  batches: PendingBatch[];
  failures: FailedApproval[];
}

let state: State = { batches: [], failures: [] };
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
/** Batches being sent, so a timer and a flush never send the same one twice. */
const sending = new Set<string>();

function set(next: State) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Queues approvals; returns the batch id for undo. */
export function approveLater(
  items: { approvalId: string; bulk: boolean; title: string }[],
  label: string,
  delayMs = UNDO_SECONDS * 1000,
): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const batch: PendingBatch = {
    id,
    approvalIds: items.map((i) => i.approvalId),
    titles: Object.fromEntries(items.map((i) => [i.approvalId, i.title])),
    label,
    routine: items.every((i) => i.bulk),
    sendsAt: Date.now() + delayMs,
  };
  set({ ...state, batches: [...state.batches, batch] });
  timers.set(
    id,
    setTimeout(() => void send(id), delayMs),
  );
  return id;
}

export function undo(batchId: string) {
  if (sending.has(batchId)) return;
  clearTimeout(timers.get(batchId));
  timers.delete(batchId);
  set({ ...state, batches: state.batches.filter((b) => b.id !== batchId) });
}

export function dismissFailures() {
  set({ ...state, failures: [] });
}

async function send(batchId: string, keepalive = false) {
  const batch = state.batches.find((b) => b.id === batchId);
  timers.delete(batchId);
  if (!batch || sending.has(batchId)) return;
  sending.add(batchId);
  const failures: FailedApproval[] = [];
  try {
    if (keepalive) {
      sendOnExit(batch);
    } else if (batch.routine && batch.approvalIds.length > 1) {
      const { results } = await api<BulkApproveResult>('/approvals/bulk-approve', {
        body: { approvalIds: batch.approvalIds },
      });
      for (const r of results) {
        if (!r.ok)
          failures.push({
            approvalId: r.approvalId,
            title: batch.titles[r.approvalId] ?? '',
            message: r.message ?? 'Not approved',
          });
      }
    } else {
      for (const approvalId of batch.approvalIds) {
        try {
          await api(`/approvals/${approvalId}/approve`, { body: {} });
        } catch (error) {
          failures.push({
            approvalId,
            title: batch.titles[approvalId] ?? '',
            message: errorMessage(error),
          });
        }
      }
    }
  } catch (error) {
    for (const approvalId of batch.approvalIds) {
      failures.push({
        approvalId,
        title: batch.titles[approvalId] ?? '',
        message: errorMessage(error),
      });
    }
  }
  sending.delete(batchId);
  set({
    batches: state.batches.filter((b) => b.id !== batchId),
    failures: [...state.failures, ...failures],
  });
  if (!keepalive) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['approvals'] }),
      queryClient.invalidateQueries({ queryKey: ['requests'] }),
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
  }
}

/** The page is going away: send what is queued with requests that outlive the page. */
function sendOnExit(batch: PendingBatch) {
  const post = (path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  if (batch.routine) void post('/approvals/bulk-approve', { approvalIds: batch.approvalIds });
  else for (const id of batch.approvalIds) void post(`/approvals/${id}/approve`, {});
}

/** Sends everything queued now and waits for it (e.g. before signing out). */
export async function sendPendingApprovals(): Promise<void> {
  const ids = state.batches.map((b) => b.id);
  for (const id of ids) clearTimeout(timers.get(id));
  await Promise.all(ids.map((id) => send(id)));
}

export function flushPendingApprovals() {
  for (const batch of state.batches) {
    clearTimeout(timers.get(batch.id));
    void send(batch.id, true);
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPendingApprovals);
  // A phone may close a backgrounded tab without warning, so leaving the app sends them too.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingApprovals();
  });
}

export function usePendingApprovals(): State {
  return useSyncExternalStore(subscribe, () => state);
}
