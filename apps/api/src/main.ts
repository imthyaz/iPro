import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { configureApp } from './security/http-hardening.js';

// Raw bodies are kept for webhook signature checks (e-sign).
const app = await NestFactory.create(AppModule, { rawBody: true });
const config = app.get<AppConfig>(APP_CONFIG);
configureApp(app, config);
app.enableShutdownHooks();
await app.listen(config.PORT);
