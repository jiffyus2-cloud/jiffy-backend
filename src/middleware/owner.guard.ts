import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { FirebaseAuthGuard } from './firebase-auth.guard';

/**
 * Solo el correo de administración de la tienda.
 *
 * Es el mismo criterio que usa `isOwner()` en firestore.rules: un ID token de
 * Firebase válido cuyo email sea el del dueño. Se puede sobreescribir con
 * `OWNER_EMAIL` para un entorno de pruebas.
 */
const DEFAULT_OWNER_EMAIL = 'jiffyus2@gmail.com';

export function ownerEmail(): string {
  return (process.env.OWNER_EMAIL || DEFAULT_OWNER_EMAIL).trim().toLowerCase();
}

@Injectable()
export class OwnerGuard extends FirebaseAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await super.canActivate(context);

    const request = context.switchToHttp().getRequest();
    const email = String(request.user?.email || '').toLowerCase();

    if (!email || email !== ownerEmail()) {
      throw new ForbiddenException('Solo el dueño de la tienda puede hacer esto');
    }
    return true;
  }
}
