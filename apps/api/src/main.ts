import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config.js';

// Raw bodies are kept for webhook signature checks (e-sign).
const app = await NestFactory.create(AppModule, { rawBody: true });
app.setGlobalPrefix('api');
app.enableShutdownHooks();

const config = app.get<AppConfig>(APP_CONFIG);
await app.listen(config.PORT);
