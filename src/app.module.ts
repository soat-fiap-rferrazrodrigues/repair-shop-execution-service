import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { ConfigModule } from '@nestjs/config';
import { ExecutionController } from './execution/execution.controller';
import { HealthController } from './health/health.controller';
import {
  commandConsumerProvider,
  eventPublisherProvider,
  repositoryProvider,
  serviceProvider,
} from './providers';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [ExecutionController, HealthController],
  providers: [
    {
      provide: APP_GUARD,
      inject: [Reflector],
      useFactory: (r: Reflector) => new JwtAuthGuard(r),
    },
    repositoryProvider,
    eventPublisherProvider,
    serviceProvider,
    commandConsumerProvider,
  ],
})
export class AppModule {}
