import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { OwnerGuard } from '../middleware/owner.guard';

/**
 * Autoriza la limpieza automática a dos llamantes distintos:
 *
 * - El dueño desde el panel, con su ID token de Firebase (`OwnerGuard`).
 * - Cloud Scheduler, que no tiene sesión de Firebase: manda el header
 *   `x-cleanup-token` con el valor de `STORAGE_CLEANUP_TOKEN`. Si la variable
 *   no está definida, esa vía queda cerrada y solo entra el dueño.
 *
 * `request.cleanupTrigger` queda en 'panel' o 'scheduler' para que el
 * resultado deje constancia de quién disparó la limpieza.
 */
export const STORAGE_CLEANUP_TOKEN_ENV = 'STORAGE_CLEANUP_TOKEN';

@Injectable()
export class CleanupAuthGuard implements CanActivate {
  private readonly ownerGuard = new OwnerGuard();

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const presented = String(request.headers['x-cleanup-token'] || '');
    const expected = (process.env[STORAGE_CLEANUP_TOKEN_ENV] || '').trim();

    if (presented) {
      if (expected && safeEqual(presented, expected)) {
        request.cleanupTrigger = 'scheduler';
        return true;
      }
      throw new UnauthorizedException('Token de limpieza inválido');
    }

    await this.ownerGuard.canActivate(context);
    request.cleanupTrigger = 'panel';
    return true;
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
