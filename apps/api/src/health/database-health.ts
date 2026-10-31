import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';
import { PG_POOL } from '../db/tokens.js';

@Injectable()
export class DatabaseHealth {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async isUp(): Promise<boolean> {
    try {
      await this.pool.query('select 1');
      return true;
    } catch {
      return false;
    }
  }
}
