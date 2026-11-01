import { Module } from '@nestjs/common';
import { PoliciesController } from './policies.controller.js';
import { PoliciesService } from './policies.service.js';

/** Policy documents and in-app acknowledgements; search chunks for Ask iPro arrive in slice 12. */
@Module({
  controllers: [PoliciesController],
  providers: [PoliciesService],
  exports: [PoliciesService],
})
export class PoliciesModule {}
