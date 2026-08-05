import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initFirebaseAdmin } from './firebase/firebase-admin';

/**
 * Origenes permitidos por CORS.
 *
 * Se configura con ALLOWED_ORIGINS (lista separada por comas). Si no está
 * definida, se cae a FRONTEND_URL más los puertos de desarrollo habituales.
 * Si tampoco hay FRONTEND_URL mantenemos el comportamiento permisivo anterior
 * para no tumbar un despliegue cuya configuración no podemos ver, pero lo
 * avisamos de forma bien visible.
 */
function resolveCorsOrigin(): true | string[] {
  const explicit = process.env.ALLOWED_ORIGINS;
  if (explicit) {
    return explicit.split(',').map(o => o.trim()).filter(Boolean);
  }

  const frontendUrl = process.env.FRONTEND_URL || process.env.VITE_FRONTEND_URL;
  if (frontendUrl) {
    return [frontendUrl, 'http://localhost:5173', 'http://localhost:3000'];
  }

  console.warn(
    '⚠️  CORS abierto a cualquier origen: define ALLOWED_ORIGINS (o FRONTEND_URL) para restringirlo.'
  );
  return true;
}

async function bootstrap() {
  // Antes de levantar nada: sin Firebase no podemos verificar tokens ni leer
  // los pedidos, así que un fallo aquí debe abortar el arranque en lugar de
  // dejar el servicio en pie aceptando peticiones que no sabremos autorizar.
  await initFirebaseAdmin();

  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin: resolveCorsOrigin(),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  await app.listen(process.env.PORT || 8080, '0.0.0.0');
}

bootstrap().catch(error => {
  console.error('❌ El servidor no pudo arrancar:', error?.message ?? error);
  process.exit(1);
});
