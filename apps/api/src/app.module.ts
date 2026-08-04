import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { ProjectsController } from './projects.controller.js';
import { ProjectsService } from './projects.service.js';
import { TEMPORAL_GATEWAY, TemporalGateway } from './temporal-gateway.js';

@Module({
  controllers: [HealthController, ProjectsController],
  providers: [
    ProjectsService,
    { provide: TEMPORAL_GATEWAY, useClass: TemporalGateway },
  ],
})
export class AppModule {}
