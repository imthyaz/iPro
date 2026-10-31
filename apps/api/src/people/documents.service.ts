import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DocumentView } from '@ipro/shared';
import { AuditService } from '../audit/audit.service.js';
import { AuthzService, type Resource } from '../authz/authz.service.js';
import type { Action } from '../authz/permissions.js';
import { requireContext } from '../context/request-context.js';
import { TenantDb } from '../db/tenant-db.js';
import {
  DOWNLOAD_LINK_SECONDS,
  OBJECT_STORAGE,
  type ObjectStorage,
} from '../storage/object-storage.js';
import { documents } from './documents.schema.js';
import { PeopleService } from './people.service.js';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** Accepted types, checked against the file's first bytes rather than trusting the browser. */
const signatures: Record<string, number[]> = {
  'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/png': [0x89, 0x50, 0x4e, 0x47],
};

export function detectContentType(body: Buffer): string | null {
  for (const [type, magic] of Object.entries(signatures)) {
    if (magic.every((byte, i) => body[i] === byte)) return type;
  }
  return null;
}

/** Keeps only the last path segment and printable characters. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const printable = [...base].filter((ch) => ch.charCodeAt(0) > 0x1f && ch.charCodeAt(0) !== 0x7f);
  const cleaned = printable.join('').trim().slice(0, 150);
  return cleaned || 'file';
}

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  size: number;
}

type DocumentRow = typeof documents.$inferSelect;

const toView = (row: DocumentRow): DocumentView => ({
  id: row.id,
  type: row.type,
  title: row.title,
  fileName: row.fileName,
  contentType: row.contentType,
  sizeBytes: row.sizeBytes,
  version: row.version,
  confidential: row.confidential,
  uploadedAt: row.createdAt.toISOString(),
  signedAt: row.signedAt?.toISOString() ?? null,
});

/**
 * Person documents in object storage. KYC scans are governed by the KYC row of the permissions table:
 * employees upload and open their own; HR and HR head open anyone’s (decision #39).
 */
@Injectable()
export class DocumentsService {
  constructor(
    @Inject(TenantDb) private readonly db: TenantDb,
    @Inject(AuthzService) private readonly authz: AuthzService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(PeopleService) private readonly people: PeopleService,
  ) {}

  async upload(
    personId: string,
    file: IncomingFile | undefined,
    meta: { type: DocumentView['type']; title: string; confidential: boolean },
  ): Promise<DocumentView> {
    if (!file) throw new BadRequestException({ message: 'No file' });
    const contentType = detectContentType(file.buffer);
    if (!contentType) throw new BadRequestException({ message: 'Only PDF, JPEG and PNG files' });
    const { actor, tenantId } = requireContext();
    const legalEntityId = (await this.people.summary(personId)).legalEntityId;
    if (meta.type === 'kyc_scan') {
      const kyc: Resource = { area: 'kyc', subjectPersonId: personId, legalEntityId };
      const asHr = (await this.authz.check(actor!, 'update', kyc)).allowed;
      if (!asHr) await this.authz.assert(actor!, 'create', kyc);
    } else {
      await this.authz.assert(actor!, 'create', {
        area: 'documents',
        subjectPersonId: personId,
        legalEntityId,
      });
    }

    const id = randomUUID();
    // No names in keys: storage paths are ids only.
    const storageKey = `${tenantId}/people/${personId}/${id}`;
    await this.storage.put(storageKey, file.buffer, contentType);
    const row = await this.db.tx(async (tx) => {
      const [inserted] = await tx
        .insert(documents)
        .values({
          id,
          tenantId,
          personId,
          type: meta.type,
          title: meta.title,
          storageKey,
          fileName: safeFileName(file.originalname),
          contentType,
          sizeBytes: file.size,
          sha256: createHash('sha256').update(file.buffer).digest('hex'),
          confidential: meta.type === 'kyc_scan' ? true : meta.confidential,
          createdBy: actor!.userId,
          updatedBy: actor!.userId,
        })
        .returning();
      await this.audit.record(tx, {
        action: 'create',
        table: 'document',
        recordId: id,
        subjectPersonId: personId,
      });
      return inserted!;
    });
    return toView(row);
  }

  /** The person's documents the actor may see. */
  async list(personId: string): Promise<DocumentView[]> {
    const legalEntityId = (await this.people.summary(personId)).legalEntityId;
    const rows = await this.db.tx((tx) =>
      tx
        .select()
        .from(documents)
        .where(and(eq(documents.personId, personId), isNull(documents.deletedAt)))
        .orderBy(desc(documents.createdAt)),
    );
    const visible: DocumentView[] = [];
    for (const row of rows) {
      if ((await this.decide(row, legalEntityId, 'read')).allowed) visible.push(toView(row));
    }
    if (visible.length === 0 && !(await this.canSeeAny(personId, legalEntityId))) {
      throw new NotFoundException();
    }
    return visible;
  }

  /** A short-lived download link. HR opening someone’s KYC scan is audited as an unmask. */
  async downloadLink(
    personId: string,
    documentId: string,
  ): Promise<{ url: string; expiresInSeconds: number }> {
    const legalEntityId = (await this.people.summary(personId)).legalEntityId;
    const row = await this.db.tx(async (tx) => {
      const [found] = await tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.id, documentId),
            eq(documents.personId, personId),
            isNull(documents.deletedAt),
          ),
        );
      return found;
    });
    if (!row) throw new NotFoundException();
    const action: Action = row.type === 'kyc_scan' ? 'open_scan' : 'read';
    if (!(await this.decide(row, legalEntityId, action)).allowed) throw new NotFoundException();
    await this.db.tx((tx) =>
      this.audit.record(tx, {
        action:
          row.type === 'kyc_scan' && requireContext().actor!.personId !== personId
            ? 'unmask'
            : 'view',
        table: 'document',
        recordId: row.id,
        subjectPersonId: personId,
      }),
    );
    return {
      url: await this.storage.downloadUrl(row.storageKey, row.fileName, row.contentType),
      expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    };
  }

  private decide(row: DocumentRow, legalEntityId: string, action: Action) {
    const actor = requireContext().actor!;
    if (row.type === 'kyc_scan') {
      return this.authz.check(actor, action, {
        area: 'kyc',
        subjectPersonId: row.personId,
        legalEntityId,
      });
    }
    return this.authz.check(actor, action, {
      area: 'documents',
      subjectPersonId: row.personId,
      legalEntityId,
      attributes: { confidential: row.confidential },
    });
  }

  /** Whether an empty list means "nothing to show" or "not allowed to look". */
  private async canSeeAny(personId: string, legalEntityId: string): Promise<boolean> {
    const actor = requireContext().actor!;
    for (const area of ['documents', 'kyc'] as const) {
      const decision = await this.authz.check(actor, 'read', {
        area,
        subjectPersonId: personId,
        legalEntityId,
        attributes: { confidential: false },
      });
      if (decision.allowed) return true;
    }
    return false;
  }
}
