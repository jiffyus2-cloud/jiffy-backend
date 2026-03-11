import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // <-- ¡Esta línea es vital!
  
  // El '0.0.0.0' es OBLIGATORIO para que Cloud Run pueda entrar al contenedor
  await app.listen(process.env.PORT || 8080, '0.0.0.0');
}
bootstrap();