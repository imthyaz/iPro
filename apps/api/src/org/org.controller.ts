import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { z } from 'zod';
import {
  asOfQuerySchema,
  changeBusinessUnitSchema,
  changeDepartmentSchema,
  changeLocationSchema,
  closeDatedSchema,
  costCentreInputSchema,
  createBusinessUnitSchema,
  createDepartmentSchema,
  createLocationSchema,
  designationInputSchema,
  gradeInputSchema,
  gradeUpdateSchema,
  legalEntityInputSchema,
  positionInputSchema,
} from '@ipro/shared';
import { Authorize } from '../authz/decorators.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { businessDate } from '../common/effective-dating.js';
import { CatalogService, type CatalogKind } from './catalog.service.js';
import { DatedUnitsService, type DatedKind } from './dated-units.service.js';

const catalogKinds: Record<string, { kind: CatalogKind; schema: z.ZodType; update: z.ZodType }> = {
  'legal-entities': {
    kind: 'legal_entity',
    schema: legalEntityInputSchema,
    update: legalEntityInputSchema.partial(),
  },
  'cost-centres': {
    kind: 'cost_centre',
    schema: costCentreInputSchema,
    update: costCentreInputSchema.partial(),
  },
  grades: { kind: 'grade', schema: gradeInputSchema, update: gradeUpdateSchema },
  designations: {
    kind: 'designation',
    schema: designationInputSchema,
    update: designationInputSchema.partial(),
  },
  positions: {
    kind: 'position',
    schema: positionInputSchema,
    update: positionInputSchema.partial(),
  },
};

const datedKinds: Record<string, { kind: DatedKind; create: z.ZodType; change: z.ZodType }> = {
  'business-units': {
    kind: 'business_unit',
    create: createBusinessUnitSchema,
    change: changeBusinessUnitSchema,
  },
  departments: {
    kind: 'department',
    create: createDepartmentSchema,
    change: changeDepartmentSchema,
  },
  locations: { kind: 'location', create: createLocationSchema, change: changeLocationSchema },
};

function lookup<T>(map: Record<string, T>, key: string): T {
  const entry = Object.hasOwn(map, key) ? map[key] : undefined;
  if (!entry) throw new NotFoundException();
  return entry;
}

const parse = <T extends z.ZodType>(schema: T, value: unknown) =>
  new ZodPipe(schema).transform(value);

/** Organisation setup (screen A1). */
@Controller('org')
export class OrgController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(DatedUnitsService) private readonly units: DatedUnitsService,
  ) {}

  @Authorize('org_config', 'read')
  @Get('catalog/:kind')
  listCatalog(@Param('kind') kind: string) {
    return this.catalog.list(lookup(catalogKinds, kind).kind);
  }

  @Authorize('org_config', 'create')
  @Post('catalog/:kind')
  createCatalog(@Param('kind') kind: string, @Body() body: unknown) {
    const entry = lookup(catalogKinds, kind);
    return this.catalog.create(entry.kind, parse(entry.schema, body) as Record<string, unknown>);
  }

  @Authorize('org_config', 'update')
  @Patch('catalog/:kind/:id')
  updateCatalog(
    @Param('kind') kind: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const entry = lookup(catalogKinds, kind);
    return this.catalog.update(
      entry.kind,
      id,
      parse(entry.update, body) as Record<string, unknown>,
    );
  }

  @Authorize('org_config', 'delete')
  @Delete('catalog/:kind/:id')
  @HttpCode(204)
  async removeCatalog(@Param('kind') kind: string, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.catalog.remove(lookup(catalogKinds, kind).kind, id);
  }

  @Authorize('org_config', 'read')
  @Get('units/:kind')
  listUnits(
    @Param('kind') kind: string,
    @Query(new ZodPipe(asOfQuerySchema)) query: { asOf?: string },
  ) {
    return this.units.list(lookup(datedKinds, kind).kind, query.asOf ?? businessDate(new Date()));
  }

  @Authorize('org_config', 'read')
  @Get('units/:kind/:id/versions')
  history(@Param('kind') kind: string, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.units.history(lookup(datedKinds, kind).kind, id);
  }

  @Authorize('org_config', 'create')
  @Post('units/:kind')
  createUnit(@Param('kind') kind: string, @Body() body: unknown) {
    const entry = lookup(datedKinds, kind);
    return this.units.create(
      entry.kind,
      parse(entry.create, body) as Record<string, unknown> & {
        code: string;
        effectiveFrom: string;
      },
    );
  }

  @Authorize('org_config', 'update')
  @Post('units/:kind/:id/changes')
  changeUnit(
    @Param('kind') kind: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ) {
    const entry = lookup(datedKinds, kind);
    return this.units.change(
      entry.kind,
      id,
      parse(entry.change, body) as Record<string, unknown> & { effectiveFrom: string },
    );
  }

  @Authorize('org_config', 'update')
  @Post('units/:kind/:id/close')
  closeUnit(
    @Param('kind') kind: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(closeDatedSchema)) body: { effectiveTo: string },
  ) {
    return this.units.close(lookup(datedKinds, kind).kind, id, body.effectiveTo);
  }
}
