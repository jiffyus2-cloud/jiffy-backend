import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // <-- ¡Esta línea es vital!
  // Escucha en el puerto definido por Cloud Run o el 8080 por defecto
  await app.listen(process.env.PORT || 8080);
}
bootstrap();
