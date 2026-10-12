import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { AlertService } from './alert/alert.service';
import cookieParser = require('cookie-parser');
import helmet from 'helmet';
import { RedactingLogger } from './common/redacting.logger';
import { corsOrigin } from './config/origins';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new RedactingLogger() });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
    referrerPolicy: { policy: 'no-referrer' },
  }));

  // Behind a reverse proxy, trust its X-Forwarded-For so audit logs and rate limits see the real client IP.
  if (process.env.TRUST_PROXY) app.getHttpAdapter().getInstance().set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
  });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  app.useGlobalFilters(new AllExceptionsFilter(app.get(AlertService)));

  app.setGlobalPrefix('api');

  const port = process.env.PORT ?? 3069;
  // Loopback by default: only a local reverse proxy (or the compose port mapping) can reach the API.
  const host = process.env.HOST ?? '127.0.0.1';
  await app.listen(port, host);

  // Startup alert
  app.get(AlertService).send(`✅ <b>Backend started</b> on ${host}:${port}`).catch(() => {});
}
bootstrap();
