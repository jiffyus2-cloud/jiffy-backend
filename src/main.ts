import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // En tu archivo main.ts
  const app = await NestFactory.create(AppModule, { rawBody: true });
  
  // Configuración CORS a prueba de balas para Google Cloud
  app.enableCors({
    origin: true, // Permite que cualquier frontend (incluyendo localhost) se conecte
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Escuchando en el puerto dinámico con 0.0.0.0 para aceptar tráfico externo
  await app.listen(process.env.PORT || 8080, '0.0.0.0');
}
bootstrap();