import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Se requiere el header Authorization: Bearer <token>');
    }

    const token = authHeader.split(' ')[1];
    try {
      request.user = await admin.auth().verifyIdToken(token);
      return true;
    } catch (error: any) {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}
