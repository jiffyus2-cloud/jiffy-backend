import { Body, Controller, Headers, Post } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { DiscountsService } from './discounts.service';

@Controller('discounts')
export class DiscountsController {
  constructor(private readonly discountsService: DiscountsService) {}

  /**
   * Comprueba un código antes de pagar y devuelve el descuento que corresponde.
   *
   * No lleva FirebaseAuthGuard a propósito: un código sin límite por cliente
   * también tiene que poder comprobarse sin sesión iniciada. Ahora bien, el uid
   * sale SIEMPRE del token, nunca del cuerpo de la petición — si el navegador
   * pudiera decir de quién es la compra, el límite por cliente no valdría nada.
   */
  @Post('validate')
  async validate(
    @Body() body: { code: string; subtotal: number },
    @Headers('authorization') authorization?: string,
  ) {
    const uid = await resolveOptionalUid(authorization);
    return this.discountsService.validate(body?.code, body?.subtotal, uid);
  }
}

/** uid del token, o null si no hay token o no es válido. */
async function resolveOptionalUid(authorization?: string): Promise<string | null> {
  const token = (authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    return decoded.uid;
  } catch (error: any) {
    // Un token caducado no es un error del servidor: se trata como visitante sin
    // sesión, y los códigos con límite por cliente le pedirán iniciar sesión.
    console.warn('[Códigos] Token rechazado al validar un código:', error.message);
    return null;
  }
}
