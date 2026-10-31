import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Validates a body or query with a zod schema from @ipro/shared. Errors name fields, never values. */
export class ZodPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: 'Invalid request',
        fields: [...new Set(result.error.issues.map((issue) => issue.path.join('.')))],
      });
    }
    return result.data;
  }
}
