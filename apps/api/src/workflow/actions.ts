import { Injectable } from '@nestjs/common';
import type { ChangeLine } from '@ipro/shared';
import type { Actor } from '../context/request-context.js';
import type { Tx } from '../db/tenant-context.js';

export interface ActionInstance {
  id: string;
  subjectPersonId: string;
  submittedBy: string;
  payload: Record<string, unknown>;
}

/**
 * What a workflow does on final approval. Definitions refer to actions by name; modules register
 * them at start-up. Approval data is configuration; the effect itself is code.
 */
export interface WorkflowAction {
  /** Checks a payload on submit and resubmit; throw a 400 for bad input. */
  validate(payload: Record<string, unknown>): Record<string, unknown>;
  /** Field-by-field "from → to", so the approver decides on the card (CLAUDE.md design rules). */
  describe(tx: Tx, instance: ActionInstance): Promise<ChangeLine[]>;
  /** Applies the change in the approval's transaction, as the final approver. */
  apply(tx: Tx, instance: ActionInstance, approver: Actor): Promise<void>;
  /** May anyone who can read the subject's profile start it through POST /api/workflows? */
  genericSubmit?: boolean;
}

@Injectable()
export class WorkflowActions {
  private readonly actions = new Map<string, WorkflowAction>();

  constructor() {
    // Records the decision only; for workflows whose outcome another module acts on later.
    this.register('none', {
      validate: (payload) => payload,
      describe: async () => [],
      apply: async () => undefined,
      genericSubmit: true,
    });
  }

  register(name: string, action: WorkflowAction): void {
    if (this.actions.has(name)) throw new Error(`Workflow action ${name} is already registered`);
    this.actions.set(name, action);
  }

  get(name: string): WorkflowAction {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Unknown workflow action ${name}`);
    return action;
  }

  has(name: string): boolean {
    return this.actions.has(name);
  }
}
