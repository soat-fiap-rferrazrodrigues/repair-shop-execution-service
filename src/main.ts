import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { JsonLogger, correlationMiddleware } from './logging/json.logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: new JsonLogger(process.env.DD_SERVICE ?? 'execution-service'),
  });
  app.use(correlationMiddleware);
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Execution Service')
    .setDescription(
      'Fila de execução (diagnóstico → reparo → finalização) e estoque de peças (DynamoDB). ' +
        'Reserva de peças chega via SQS (execution.ReserveAndEnqueue).',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(process.env.PORT ?? 3002);
}
void bootstrap();
