import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  appliesToSchema,
  type AppliesTo,
  type MyPolicyView,
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
import { detectContentType, type IncomingFile } from '../people/documents.service.js';
import { assignments, engagements, persons } from '../people/people.schema.js';
import {
  DOWNLOAD_LINK_SECONDS,
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.js';
import { appliesToMatches } from '../workflow/checklist-rules.js';
import { notify, userOfPerson } from '../workflow/lookups.js';
import { policies, policyAcknowledgements, policyVersions } from './policies.schema.js';

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

  /** Publishes a PDF as the next version and asks everyone it applies to for acceptance. */
  async publish(
    policyId: string,
    file: IncomingFile | undefined,
    meta: { effectiveFrom: string; summary?: string },
  ): Promise<PolicyStatusView> {
    const { actor, tenantId } = requireContext();
    await this.authz.assert(actor!, 'update', { area: 'org_config' });
    if (!file) throw new BadRequestException({ message: 'No file' });
    if (detectContentType(file.buffer) !== 'application/pdf') {
      throw new BadRequestException({ message: 'Policies are published as PDF' });
    }
    const today = businessDate(new Date());
    await this.db.tx(async (tx) => {
      const policy = await this.load(tx, policyId);
      const [latest] = await tx
        .select({ version: policyVersions.version })
        .from(policyVersions)
        .where(eq(policyVersions.policyId, policyId))
        .orderBy(desc(policyVersions.version))
        .limit(1);
      const id = randomUUID();
      const storageKey = `${tenantId}/policies/${policyId}/${id}`;
      await this.storage.put(storageKey, file.buffer, 'application/pdf');
      const version = (latest?.version ?? 0) + 1;
      await tx.insert(policyVersions).values({
        id,
        tenantId,
        policyId,
        version,
        effectiveFrom: meta.effectiveFrom,
        summary: meta.summary ?? null,
        storageKey,
        fileName: file.originalname.split(/[\\/]/).pop() || `${policy.code}.pdf`,
        contentType: 'application/pdf',
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
    });
    return this.status(policyId);
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
