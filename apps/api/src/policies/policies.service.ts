import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  appliesToSchema,
  type AppliesTo,
  type MyPolicyView,
  type PolicyClausesView,
  type PolicyInput,
  type PolicyStatusView,
  type PolicyVersionView,
} from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService } from '../authz/authz.service.js';
import { businessDate } from '../common/effective-dating.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import type { Tx } from '../db/tenant-context.js';
import type { IncomingFile } from '../people/documents.service.js';
import { assignments, engagements, persons } from '../people/people.schema.js';
import {
  DOWNLOAD_LINK_SECONDS,
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { notify, userOfPerson } from '../workflow/lookups.js';
import { anyWordQuery, policyFileType, splitClauses, WORD_DOCX } from './clause-rules.js';
import {
  policies,
  policyAcknowledgements,
  policyClauses,
  policyVersions,
} from './policies.schema.js';
import { readPolicyText } from './policy-text.js';

/** A clause Ask iPro found for a question, with the policy it belongs to. */
export interface ClauseHit {
  policyId: string;
  policyTitle: string;
  version: number;
  position: number;
  number: string | null;
  heading: string;
  body: string;
}

type VersionRow = typeof policyVersions.$inferSelect;

/** Everyone who may need to accept policies: offered and pre-joining people too (onboarding, slice 4). */
const LIVE = ['offered', 'pre_joining', 'active', 'on_notice'] as const;

const versionView = (v: VersionRow): PolicyVersionView => ({
  id: v.id,
  version: v.version,
  effectiveFrom: v.effectiveFrom,
  summary: v.summary,
  fileName: v.fileName,
  contentHash: v.contentHash,
  publishedAt: v.publishedAt.toISOString(),
  textStatus: v.textStatus,
  clauseCount: v.clauseCount,
});

interface Applicable {
  personId: string;
  name: string;
  employeeCode: string;
  legalEntityId: string;
}

/**
 * Policies and in-app acknowledgements (spec: integrations; decision #52). Acceptances are per
 * version, so publishing a new version re-opens acknowledgement for everyone it applies to.
 */
@Injectable()
export class PoliciesService {
  private readonly log = new Logger('Policies');

  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async create(input: PolicyInput): Promise<PolicyStatusView> {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'update', { area: 'org_config' });
    const id = await this.db.tx(async (tx) => {
      const [existing] = await tx
        .select({ id: policies.id })
        .from(policies)
        .where(eq(policies.code, input.code));
      if (existing) throw new ConflictException({ message: 'A policy with this code exists' });
      const [row] = await tx
        .insert(policies)
        .values({ tenantId, ...input, createdBy: actor!.userId, updatedBy: actor!.userId })
        .returning({ id: policies.id });
      await this.audit.record(tx, { action: 'create', table: 'policy', recordId: row!.id });
      return row!.id;
    });
    return this.status(id);
  }

  /**
   * Publishes a PDF or Word file as the next version and asks everyone it applies to for acceptance.
   * Its text is then read into clauses for Ask iPro (decision #89).
   */
  async publish(
    policyId: string,
    file: IncomingFile | undefined,
    meta: { effectiveFrom: string; summary?: string },
  ): Promise<PolicyStatusView> {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'update', { area: 'org_config' });
    if (!file) throw new BadRequestException({ message: 'No file' });
    const fileName = file.originalname.split(/[\\/]/).pop() ?? '';
    const type = policyFileType(file.buffer, fileName);
    if (!type) {
      throw new BadRequestException({ message: 'Policies are published as PDF or Word (.docx)' });
    }
    const contentType = type === 'pdf' ? 'application/pdf' : WORD_DOCX;
    const today = businessDate(new Date());
    const versionId = await this.db.tx(async (tx) => {
      const policy = await this.load(tx, policyId);
      const [latest] = await tx
        .select({ version: policyVersions.version })
        .from(policyVersions)
        .where(eq(policyVersions.policyId, policyId))
        .orderBy(desc(policyVersions.version))
        .limit(1);
      const id = randomUUID();
      const storageKey = `${tenantId}/policies/${policyId}/${id}`;
      await this.storage.put(storageKey, file.buffer, contentType);
      const version = (latest?.version ?? 0) + 1;
      await tx.insert(policyVersions).values({
        id,
        tenantId,
        policyId,
        version,
        effectiveFrom: meta.effectiveFrom,
        summary: meta.summary ?? null,
        storageKey,
        fileName: fileName || `${policy.code}.${type}`,
        contentType,
        sizeBytes: file.size,
        contentHash: createHash('sha256').update(file.buffer).digest('hex'),
        createdBy: actor!.userId,
        updatedBy: actor!.userId,
      });
      await this.audit.record(tx, {
        action: 'create',
        table: 'policy_version',
        recordId: id,
        fieldChanges: [{ field: 'version', to: version }],
      });
      if (policy.requiresAcknowledgement) {
        const people = await this.applicable(tx, appliesToSchema.parse(policy.appliesTo), today);
        const users = (await Promise.all(people.map((p) => userOfPerson(tx, p.personId)))).filter(
          (u): u is string => u !== null,
        );
        await notify(
          tx,
          users,
          'policy_acknowledgement',
          `Please read and accept: ${policy.title} (v${version})`,
          '/policies',
        );
      }
      return id;
    });
    await this.readText(versionId, file.buffer, type);
    return this.status(policyId);
  }

  /**
   * Reads a version's text into clauses (decision #89). A file with no text (a scanned PDF) is
   * marked empty; one that can't be read is marked failed. Never throws: publishing has happened.
   */
  async readText(versionId: string, body: Buffer, type: 'pdf' | 'docx'): Promise<void> {
    const { tenantId } = requireContext();
    let status: 'ready' | 'empty' | 'failed';
    let clauses: ReturnType<typeof splitClauses> = [];
    try {
      clauses = splitClauses(await readPolicyText(body, type));
      status = clauses.length > 0 ? 'ready' : 'empty';
    } catch (error) {
      status = 'failed';
      this.log.warn(
        `Couldn't read policy version ${versionId}: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    await this.db.tx(async (tx) => {
      if (clauses.length > 0) {
        await tx.insert(policyClauses).values(
          clauses.map((c, i) => ({
            tenantId,
            policyVersionId: versionId,
            position: i + 1,
            number: c.number,
            heading: c.heading.slice(0, 300),
            body: c.body,
          })),
        );
      }
      await tx
        .update(policyVersions)
        .set({ textStatus: status, clauseCount: clauses.length, updatedAt: new Date() })
        .where(eq(policyVersions.id, versionId));
    });
  }

  /** Hourly: reads versions published before Ask iPro, or whose reading was interrupted. */
  async readPending(): Promise<number> {
    const pending = await this.db.tx((tx) =>
      tx
        .select({
          id: policyVersions.id,
          storageKey: policyVersions.storageKey,
          contentType: policyVersions.contentType,
        })
        .from(policyVersions)
        .where(eq(policyVersions.textStatus, 'pending'))
        .limit(50),
    );
    for (const v of pending) {
      try {
        const body = await this.storage.get(v.storageKey);
        await this.readText(v.id, body, v.contentType === WORD_DOCX ? 'docx' : 'pdf');
      } catch (error) {
        this.log.warn(
          `Couldn't load policy version ${v.id}: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
    return pending.length;
  }

  /**
   * Clauses of the policies that apply to the signed-in person (current versions only) that match
   * any word of the question, best first (Ask iPro's policy_search; decision #89).
   */
  async searchClauses(question: string, limit = 4): Promise<ClauseHit[]> {
    const query = anyWordQuery(question);
    if (!query) return [];
    const mine = await this.mine();
    const versionIds = mine.map((p) => p.current.id);
    if (versionIds.length === 0) return [];
    const titles = new Map(mine.map((p) => [p.current.id, p]));
    const rows = await this.db.tx((tx) =>
      tx
        .select({
          policyVersionId: policyClauses.policyVersionId,
          position: policyClauses.position,
          number: policyClauses.number,
          heading: policyClauses.heading,
          body: policyClauses.body,
          rank: sql<number>`ts_rank_cd(search, to_tsquery('english', ${query}))`,
        })
        .from(policyClauses)
        .where(
          and(
            inArray(policyClauses.policyVersionId, versionIds),
            sql`search @@ to_tsquery('english', ${query})`,
          ),
        )
        .orderBy(
          sql`ts_rank_cd(search, to_tsquery('english', ${query})) desc`,
          asc(policyClauses.position),
        )
        .limit(limit),
    );
    return rows.map((r) => {
      const p = titles.get(r.policyVersionId)!;
      return {
        policyId: p.policyId,
        policyTitle: p.title,
        version: p.current.version,
        position: r.position,
        number: r.number,
        heading: r.heading,
        body: r.body,
      };
    });
  }

  /** The current version's clauses, for people it applies to and for HR and admins. */
  async clauses(policyId: string): Promise<PolicyClausesView> {
    const actor = requireContext().actor!;
    const applies = (await this.mine()).some((p) => p.policyId === policyId);
    if (!applies && !this.authz.can(actor, 'org_config', 'read')) throw new ForbiddenException();
    return this.db.tx(async (tx) => {
      const policy = await this.load(tx, policyId);
      const current = await this.current(tx, policyId);
      if (!current) throw new NotFoundException();
      const rows = await tx
        .select()
        .from(policyClauses)
        .where(eq(policyClauses.policyVersionId, current.id))
        .orderBy(asc(policyClauses.position));
      return {
        policyId,
        title: policy.title,
        version: current.version,
        effectiveFrom: current.effectiveFrom,
        fileName: current.fileName,
        textStatus: current.textStatus,
        clauses: rows.map((c) => ({
          position: c.position,
          number: c.number,
          heading: c.heading,
          body: c.body,
        })),
      };
    });
  }

  /** Policies that apply to the signed-in person, newest version, and whether they have accepted it. */
  async mine(): Promise<MyPolicyView[]> {
    const actor = requireContext().actor!;
    const personId = actor.personId;
    if (!personId) return [];
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const all = await tx
        .select()
        .from(policies)
        .where(isNull(policies.deletedAt))
        .orderBy(asc(policies.title));
      const views: MyPolicyView[] = [];
      for (const policy of all) {
        const current = await this.current(tx, policy.id);
        if (!current) continue;
        if (
          !(await this.appliesToPerson(
            tx,
            appliesToSchema.parse(policy.appliesTo),
            personId,
            today,
          ))
        )
          continue;
        const [ack] = await tx
          .select({ acceptedAt: policyAcknowledgements.acceptedAt })
          .from(policyAcknowledgements)
          .where(
            and(
              eq(policyAcknowledgements.policyVersionId, current.id),
              eq(policyAcknowledgements.personId, personId),
            ),
          );
        views.push({
          policyId: policy.id,
          code: policy.code,
          title: policy.title,
          requiresAcknowledgement: policy.requiresAcknowledgement,
          current: versionView(current),
          acceptedAt: ack?.acceptedAt.toISOString() ?? null,
          pending: policy.requiresAcknowledgement && !ack,
        });
      }
      return views;
    });
  }

  /** A short-lived link to read a version: for people it applies to, and for HR and admins. */
  async fileLink(versionId: string): Promise<{ url: string; expiresInSeconds: number }> {
    const actor = requireContext().actor!;
    const today = businessDate(new Date());
    const version = await this.db.tx(async (tx) => {
      const [row] = await tx
        .select({ version: policyVersions, policy: policies })
        .from(policyVersions)
        .innerJoin(policies, eq(policies.id, policyVersions.policyId))
        .where(eq(policyVersions.id, versionId));
      if (!row || row.policy.deletedAt) throw new NotFoundException();
      const admin = (await this.authz.check(actor, 'read', { area: 'org_config' })).allowed;
      const reader =
        actor.personId !== null &&
        (await this.appliesToPerson(
          tx,
          appliesToSchema.parse(row.policy.appliesTo),
          actor.personId,
          today,
        ));
      if (!admin && !reader) throw new NotFoundException();
      return row.version;
    });
    return {
      url: await this.storage.downloadUrl(
        version.storageKey,
        version.fileName,
        version.contentType,
      ),
      expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    };
  }

  /**
   * Accepts the current version. The person sends the hash of what they read; if the policy has
   * changed since, they must read the new version first.
   */
  async accept(versionId: string, contentHash: string): Promise<MyPolicyView[]> {
    const { actor, tenantId, ip, userAgent, sessionId } = requireContext();
    if (!actor!.personId) throw new ForbiddenException();
    const today = businessDate(new Date());
    await this.db.tx(async (tx) => {
      const [row] = await tx
        .select({ version: policyVersions, policy: policies })
        .from(policyVersions)
        .innerJoin(policies, eq(policies.id, policyVersions.policyId))
        .where(eq(policyVersions.id, versionId));
      if (!row || row.policy.deletedAt) throw new NotFoundException();
      if (
        !(await this.appliesToPerson(
          tx,
          appliesToSchema.parse(row.policy.appliesTo),
          actor!.personId!,
          today,
        ))
      ) {
        throw new NotFoundException();
      }
      const current = await this.current(tx, row.policy.id);
      if (current!.id !== versionId || current!.contentHash !== contentHash) {
        throw new ConflictException({
          message: 'This policy has changed since you opened it; please read the latest version',
        });
      }
      const inserted = await tx
        .insert(policyAcknowledgements)
        .values({
          tenantId,
          policyVersionId: versionId,
          personId: actor!.personId!,
          userId: actor!.userId,
          contentHash,
          sessionId,
          ip,
          userAgent,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .onConflictDoNothing()
        .returning({ id: policyAcknowledgements.id });
      if (inserted[0]) {
        await this.audit.record(tx, {
          action: 'create',
          table: 'policy_acknowledgement',
          recordId: inserted[0].id,
          subjectPersonId: actor!.personId,
          fieldChanges: [
            { field: 'policy', to: row.policy.code },
            { field: 'version', to: row.version.version },
          ],
        });
      }
    });
    return this.mine();
  }

  async list(): Promise<PolicyStatusView[]> {
    await this.authz.assert(requireContext().actor!, 'read', { area: 'org_config' });
    const ids = await this.db.tx((tx) =>
      tx
        .select({ id: policies.id })
        .from(policies)
        .where(isNull(policies.deletedAt))
        .orderBy(asc(policies.title)),
    );
    return Promise.all(ids.map(({ id }) => this.status(id)));
  }

  /** Who has accepted the current version and who hasn't, limited to people the viewer may see. */
  async status(policyId: string): Promise<PolicyStatusView> {
    const actor = requireContext().actor!;
    await this.authz.assert(actor, 'read', { area: 'org_config' });
    const today = businessDate(new Date());
    return this.db.tx(async (tx) => {
      const policy = await this.load(tx, policyId);
      const versions = await tx
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.policyId, policyId))
        .orderBy(desc(policyVersions.version));
      const current = versions[0] ?? null;
      const appliesTo = appliesToSchema.parse(policy.appliesTo);
      const people = await this.applicable(tx, appliesTo, today);
      const visible: Applicable[] = [];
      for (const person of people) {
        const decision = await this.authz.check(actor, 'read', {
          area: 'profile',
          subjectPersonId: person.personId,
          legalEntityId: person.legalEntityId,
        });
        if (decision.allowed) visible.push(person);
      }
      const acks = current
        ? await tx
            .select({
              personId: policyAcknowledgements.personId,
              acceptedAt: policyAcknowledgements.acceptedAt,
            })
            .from(policyAcknowledgements)
            .where(eq(policyAcknowledgements.policyVersionId, current.id))
        : [];
      const acceptedAt = new Map(acks.map((a) => [a.personId, a.acceptedAt]));
      return {
        policyId: policy.id,
        code: policy.code,
        title: policy.title,
        appliesTo,
        requiresAcknowledgement: policy.requiresAcknowledgement,
        current: current ? versionView(current) : null,
        versions: versions.map(versionView),
        accepted: visible
          .filter((p) => acceptedAt.has(p.personId))
          .map((p) => ({
            personId: p.personId,
            name: p.name,
            acceptedAt: acceptedAt.get(p.personId)!.toISOString(),
          })),
        pending:
          current && policy.requiresAcknowledgement
            ? visible
                .filter((p) => !acceptedAt.has(p.personId))
                .map((p) => ({ personId: p.personId, name: p.name, employeeCode: p.employeeCode }))
            : [],
      };
    });
  }

  // ---- Internals ----

  /**
   * People a policy applies to today: current engagements, judged on the assignment in force today
   * (or on their joining day, for people who haven't joined yet).
   */
  private async applicable(
    tx: Tx,
    appliesTo: AppliesTo,
    today: string,
    personIds?: string[],
  ): Promise<Applicable[]> {
    const rows = await tx
      .select({ engagement: engagements, person: persons })
      .from(engagements)
      .innerJoin(persons, eq(persons.id, engagements.personId))
      .where(
        and(
          inArray(engagements.status, [...LIVE]),
          isNull(persons.deletedAt),
          personIds ? inArray(engagements.personId, personIds) : undefined,
        ),
      );
    // Every assignment of these engagements in one query; each is judged on its own date below.
    const all = rows.length
      ? await tx
          .select({
            engagementId: assignments.engagementId,
            effectiveFrom: assignments.effectiveFrom,
            effectiveTo: assignments.effectiveTo,
            departmentId: assignments.departmentId,
            locationId: assignments.locationId,
          })
          .from(assignments)
          .where(
            inArray(
              assignments.engagementId,
              rows.map((r) => r.engagement.id),
            ),
          )
      : [];
    const result: Applicable[] = [];
    for (const { engagement, person } of rows) {
      const on = engagement.joiningDate > today ? engagement.joiningDate : today;
      const assignment = all.find(
        (a) =>
          a.engagementId === engagement.id &&
          a.effectiveFrom <= on &&
          (a.effectiveTo === null || a.effectiveTo >= on),
      );
      const matches = appliesToMatches(appliesTo, {
        legalEntityId: engagement.legalEntityId,
        engagementType: engagement.type,
        departmentId: assignment?.departmentId ?? null,
        locationId: assignment?.locationId ?? null,
      });
      if (matches) {
        result.push({
          personId: person.id,
          name: person.preferredName ?? person.legalName,
          employeeCode: engagement.employeeCode,
          legalEntityId: engagement.legalEntityId,
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async appliesToPerson(
    tx: Tx,
    appliesTo: AppliesTo,
    personId: string,
    today: string,
  ): Promise<boolean> {
    return (await this.applicable(tx, appliesTo, today, [personId])).length > 0;
  }

  /** The newest version: acceptance re-opens as soon as a version is published (decision #52). */
  private async current(tx: Tx, policyId: string): Promise<VersionRow | null> {
    const [row] = await tx
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.policyId, policyId))
      .orderBy(desc(policyVersions.version))
      .limit(1);
    return row ?? null;
  }

  private async load(tx: Tx, policyId: string) {
    const [policy] = await tx.select().from(policies).where(eq(policies.id, policyId));
    if (!policy || policy.deletedAt) throw new NotFoundException();
    return policy;
  }
}
